#!/usr/bin/env node
// cron: 20 8 * * *
// new Env('whos.tv 每日任务');
// description: 自动完成 whos.tv 每日任务（签到、评分、收藏、分享），通过 Cookie 直连 /api/* 端点

/**
 * 环境变量配置
 *
 * 必需:
 *   WHOS_COOKIE          浏览器复制的完整 Cookie（须含 laravel_session；支持 "Cookie: " 前缀、引号、多行）
 *
 * 可选:
 *   WHOS_BASE_URL        站点 URL，默认 https://whos.tv
 *   WHOS_TIMEOUT_MS      单请求超时（毫秒），默认 30000
 *   WHOS_RATE_SCORE      评分分数 1-5，默认 5
 *   WHOS_FRAME_ID_MAX    帧 ID 采样上界，默认 106896533
 *   WHOS_FRAME_ID_SPAN   采样区间宽度，默认 3000000
 *   WHOS_KEEP_FAVORITES  true 时永不取消收藏，默认 false
 *
 * CLI:
 *   --status-only        只读模式：验证会话并显示任务进度，不执行任何写操作
 *   --help               显示帮助信息
 */

const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_BASE_URL = 'https://whos.tv';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_RATE_SCORE = 5;
const DEFAULT_FRAME_ID_MAX = 106896533;
const DEFAULT_FRAME_ID_SPAN = 3000000;
const MAX_CANDIDATE_ATTEMPTS = 120;
const MAX_CONSECUTIVE_ERRORS = 3;
const MAX_RESPONSE_BYTES = 64 * 1024;
const LOG_PREFIX = '[whos-daily]';
const TASK_TITLE = 'whos.tv 每日任务';

const TASK_KEYS = ['daily_signin', 'task_frame_rating', 'task_favorite_content', 'task_share'];
const TASK_NAME = {
  daily_signin: '签到',
  task_frame_rating: '评分',
  task_favorite_content: '收藏',
  task_share: '分享',
};

const PAUSE_MIN_MS = 1000;
const PAUSE_MAX_MS = 2000;

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

// ============================================================================
// Error
// ============================================================================

class WhosDailyError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'WhosDailyError';
    this.type = details.type || 'runtime_error';
    this.statusCode = details.statusCode;
    this.path = details.path;
  }
}

// ============================================================================
// Config and Args
// ============================================================================

function loadDotEnv() {
  const candidates = [
    path.join(process.cwd(), '.env'),
    path.join(__dirname, '..', '.env'),
  ];
  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (match && !Object.prototype.hasOwnProperty.call(process.env, match[1])) {
          let value = match[2];
          if ((value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          process.env[match[1]] = value;
        }
      }
      break;
    }
  }
}

function normalizeCookie(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let text = raw.trim();
  // Remove "Cookie: " prefix if present
  if (text.toLowerCase().startsWith('cookie:')) {
    text = text.slice(7).trim();
  }
  // Remove surrounding quotes
  if ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }
  // Collapse multiline to single line
  text = text.replace(/\s*\n\s*/g, ' ').trim();
  return text;
}

function normalizeBaseUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = new URL(raw.trim());
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function parsePositiveInteger(raw, defaultValue) {
  const n = parseInt(raw, 10);
  return (Number.isFinite(n) && n > 0) ? n : defaultValue;
}

function parseBoolean(raw) {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const lower = raw.trim().toLowerCase();
    return lower === 'true' || lower === '1';
  }
  return false;
}

function parseScore(raw, defaultValue) {
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 1 && n <= 5) return n;
  if (raw) {
    console.warn(`${LOG_PREFIX} WHOS_RATE_SCORE 超出范围 [1,5]，回落到 ${defaultValue}`);
  }
  return defaultValue;
}

function getConfig(env = process.env) {
  const cookie = normalizeCookie(env.WHOS_COOKIE);
  if (!cookie) {
    throw new WhosDailyError(
      '缺少必需环境变量 WHOS_COOKIE\n' +
      '\n获取步骤:\n' +
      '  1. 登录 https://whos.tv\n' +
      '  2. 打开浏览器开发者工具 (F12)\n' +
      '  3. 切换到 Network 标签\n' +
      '  4. 刷新页面或访问任意 /api/ 请求\n' +
      '  5. 在 Request Headers 中找到 Cookie 行，复制整行值\n' +
      '  6. 设置环境变量: WHOS_COOKIE="<复制的内容>"\n',
      { type: 'config_error' }
    );
  }

  const baseUrlRaw = env.WHOS_BASE_URL || DEFAULT_BASE_URL;
  const baseUrl = normalizeBaseUrl(baseUrlRaw);
  if (!baseUrl) {
    throw new WhosDailyError(`WHOS_BASE_URL 无效: ${baseUrlRaw}`, { type: 'config_error' });
  }

  return {
    cookie,
    baseUrl,
    timeoutMs: parsePositiveInteger(env.WHOS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    rateScore: parseScore(env.WHOS_RATE_SCORE, DEFAULT_RATE_SCORE),
    frameIdMax: parsePositiveInteger(env.WHOS_FRAME_ID_MAX, DEFAULT_FRAME_ID_MAX),
    frameIdSpan: parsePositiveInteger(env.WHOS_FRAME_ID_SPAN, DEFAULT_FRAME_ID_SPAN),
    keepFavorites: parseBoolean(env.WHOS_KEEP_FAVORITES),
  };
}

function parseArgs(argv) {
  const args = { statusOnly: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--status-only') {
      args.statusOnly = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new WhosDailyError(`未知参数: ${arg}，使用 --help 查看帮助`, { type: 'config_error' });
    }
  }
  return args;
}

function printUsage() {
  console.log(`
whos.tv 每日任务自动化

用法:
  node gongyizhan/whos-daily.js [选项]

选项:
  --status-only    只读模式：验证会话并显示任务进度，不执行任何写操作
  --help, -h       显示此帮助信息

环境变量:
  WHOS_COOKIE          (必需) 浏览器复制的完整 Cookie
  WHOS_BASE_URL        站点 URL，默认 ${DEFAULT_BASE_URL}
  WHOS_TIMEOUT_MS      单请求超时（毫秒），默认 ${DEFAULT_TIMEOUT_MS}
  WHOS_RATE_SCORE      评分分数 1-5，默认 ${DEFAULT_RATE_SCORE}
  WHOS_FRAME_ID_MAX    帧 ID 采样上界，默认 ${DEFAULT_FRAME_ID_MAX}
  WHOS_FRAME_ID_SPAN   采样区间宽度，默认 ${DEFAULT_FRAME_ID_SPAN}
  WHOS_KEEP_FAVORITES  true 时永不取消收藏，默认 false

示例:
  WHOS_COOKIE="laravel_session=xxx" node gongyizhan/whos-daily.js
  node gongyizhan/whos-daily.js --status-only

青龙面板:
  脚本路径 /ql/data/scripts/gongyizhan/whos-daily.js
  定时规则 20 8 * * *
  环境变量中配置 WHOS_COOKIE
`);
}

// ============================================================================
// Transport Layer
// ============================================================================

function scrubText(text) {
  if (!text || typeof text !== 'string') return '';
  let scrubbed = text
    .replace(/laravel_session=[^;]*/gi, 'laravel_session=[redacted]')
    .replace(/whostv_cache_bypass=[^;]*/gi, 'whostv_cache_bypass=[redacted]')
    .replace(/XSRF-TOKEN=[^;]*/gi, 'XSRF-TOKEN=[redacted]')
    .replace(/cf_clearance=[^;]*/gi, 'cf_clearance=[redacted]');
  if (scrubbed.length > 300) {
    scrubbed = scrubbed.slice(0, 300) + '... [truncated]';
  }
  return scrubbed;
}

function mergeSetCookie(jar, headers) {
  const raw = headers['set-cookie'] || [];
  const setCookies = Array.isArray(raw) ? raw : [raw];
  for (const cookieStr of setCookies) {
    const match = String(cookieStr).match(/^([^=]+)=([^;]*)/);
    if (!match) continue;
    const name = match[1].trim();
    const value = match[2].trim();
    // 站点用 Max-Age=0 清空 whostv_cache_bypass 之类的 cookie，此时应从 jar 删除而不是存空值
    if (/;\s*max-age=0(;|$)/i.test(cookieStr) || value === '') {
      delete jar[name];
    } else {
      jar[name] = value;
    }
  }
}

function parseCookieJar(cookieHeader) {
  const jar = {};
  for (const pair of String(cookieHeader || '').split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name) jar[name] = value;
  }
  return jar;
}

function buildCookieHeader(jar) {
  return Object.entries(jar)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function requestJson(config, state, apiPath, options = {}) {
  return new Promise((resolve, reject) => {
    const { method = 'GET', body } = options;
    const fullUrl = `${config.baseUrl}${apiPath}`;
    const parsed = new URL(fullUrl);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const headers = {
      'Accept': 'application/json',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Content-Type': 'application/json',
      'Cookie': buildCookieHeader(state.cookies),
      'Origin': config.baseUrl,
      'Referer': `${config.baseUrl}/`,
      'User-Agent': USER_AGENT,
      'Cache-Control': 'no-cache',
    };

    // 前端 window.ajax 对无参数 POST 发送 body=null 且仍带 Content-Type: application/json，这里保持一致
    let postData = null;
    if (body !== undefined && body !== null) {
      postData = JSON.stringify(body);
      headers['Content-Length'] = Buffer.byteLength(postData);
    } else if (method !== 'GET' && method !== 'HEAD') {
      headers['Content-Length'] = '0';
    }

    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
      timeout: config.timeoutMs,
    };

    const req = transport.request(reqOptions, (res) => {
      const statusCode = res.statusCode || 0;
      const contentType = (res.headers['content-type'] || '').toLowerCase();
      const location = res.headers['location'] || '';
      const cfMitigated = (res.headers['cf-mitigated'] || '').includes('challenge');
      const retryAfter = res.headers['retry-after'] || '';

      // Merge Set-Cookie into the jar
      mergeSetCookie(state.cookies, res.headers);

      const chunks = [];
      let totalBytes = 0;

      res.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes <= MAX_RESPONSE_BYTES) {
          chunks.push(chunk);
        }
      });

      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const looksLikeHtml = raw.trim().startsWith('<') ||
                               /<!doctype\s+html/i.test(raw.slice(0, 100));

        let payload = null;
        if (contentType.includes('application/json') ||
            (statusCode >= 200 && statusCode < 300 && !looksLikeHtml && raw.trim().startsWith('{'))) {
          try {
            payload = JSON.parse(raw);
          } catch {
            payload = null;
          }
        }

        const textPreview = scrubText(raw);

        resolve({
          statusCode,
          contentType,
          location,
          looksLikeHtml,
          cfMitigated,
          retryAfter,
          payload,
          textPreview,
        });
      });
    });

    req.on('error', (err) => {
      if (err instanceof WhosDailyError) {
        reject(err);
      } else {
        reject(new WhosDailyError(`网络错误: ${err.message}`, {
          type: 'network_error',
          path: apiPath,
        }));
      }
    });

    req.on('timeout', () => {
      req.destroy(new WhosDailyError(`请求超时 (${config.timeoutMs}ms)`, {
        type: 'network_error',
        path: apiPath,
      }));
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

// ============================================================================
// Classification
// ============================================================================

function classifyTransport(result) {
  const { statusCode, location, looksLikeHtml, cfMitigated, payload } = result;

  // 3xx redirect to login
  if (statusCode >= 300 && statusCode < 400) {
    if (location && (location.includes('login=1') || location.includes('/login'))) {
      return 'auth_failed';
    }
    // Other redirects not yet classified
    return 'api_error';
  }

  // 401
  if (statusCode === 401) {
    return 'auth_failed';
  }

  // 403
  if (statusCode === 403) {
    if (payload) {
      return 'auth_failed'; // JSON 403 = auth
    }
    if (looksLikeHtml || cfMitigated) {
      return 'challenge_required';
    }
    return 'auth_failed';
  }

  // 429
  if (statusCode === 429) {
    return 'rate_limited';
  }

  // 404
  if (statusCode === 404) {
    return 'not_found';
  }

  // 405
  if (statusCode === 405) {
    return 'schema_changed';
  }

  // 5xx
  if (statusCode >= 500) {
    return 'api_error';
  }

  // 2xx
  if (statusCode >= 200 && statusCode < 300) {
    if (payload === null) {
      return looksLikeHtml ? 'challenge_required' : 'schema_changed';
    }
    return 'ok';
  }

  // Other 4xx
  if (statusCode >= 400 && statusCode < 500) {
    return 'api_error';
  }

  return 'unknown';
}

function getRetryAfterMs(result) {
  const seconds = Number.parseInt(String(result?.retryAfter ?? ''), 10);
  const bounded = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 120) : 60;
  return bounded * 1000;
}

// ============================================================================
// Business Analyzers
// ============================================================================

function isSuccessPayload(p) {
  if (!p) return false;
  if (p.success === true) return true;
  const code = Number(p.code);
  return code === 0 || code === 200 || code === 200000;
}

function getMessage(p) {
  if (!p) return '';
  const text = p.message || p.error || p.msg || '';
  return (typeof text === 'string') ? text.trim() : '';
}

function getPayloadCode(p) {
  if (!p) return null;
  return p.code !== undefined ? Number(p.code) : null;
}

function firstFinite(...values) {
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

// ============================================================================
// Task Response Analyzer (tolerant parser)
// ============================================================================

function analyzeTasksResponse(payload) {
  const tasks = {};
  const KNOWN_KEYS = new Set(TASK_KEYS);
  const KEY_FIELDS = ['task_key', 'key', 'type', 'name', 'code', 'slug'];

  // 实测结构（2026-09-17）：data.daily[] 每项 { task_key, target: 1, max_completions: 5,
  // progress: { current, target, today_completions } }。target 是"单次完成"的目标值，
  // 每日上限是 max_completions，今日完成数是 progress.today_completions；其余字段名为兼容备选。
  function extractProgress(obj) {
    const prog = obj.progress && typeof obj.progress === 'object' ? obj.progress : null;
    let current = firstFinite(
      prog && prog.today_completions,
      obj.today_completions,
      prog && prog.current,
      obj.current,
      typeof obj.progress === 'number' ? obj.progress : undefined,
      obj.count,
      obj.done,
      obj.today_count,
    );
    let max = firstFinite(
      obj.max_completions,
      obj.max,
      obj.daily_limit,
      obj.limit,
      obj.target,
      prog && prog.target,
      obj.total,
      obj.required,
    );
    if (max === 0 && (obj.completed === true || obj.is_completed === true || obj.finished === true)) {
      current = 1;
      max = 1;
    }
    return { current, max };
  }

  function walk(obj, depth) {
    if (depth > 6 || !obj || typeof obj !== 'object') return;

    // Check if obj itself is a task object
    for (const keyField of KEY_FIELDS) {
      const val = obj[keyField];
      if (typeof val === 'string' && KNOWN_KEYS.has(val)) {
        tasks[val] = extractProgress(obj);
        return;
      }
    }

    // Check if obj is a mapping of task keys
    for (const taskKey of KNOWN_KEYS) {
      if (obj[taskKey] && typeof obj[taskKey] === 'object') {
        tasks[taskKey] = extractProgress(obj[taskKey]);
      }
    }

    // Recurse into children
    for (const child of Object.values(obj)) {
      if (child && typeof child === 'object') {
        walk(child, depth + 1);
      }
    }
  }

  walk(payload, 0);

  // At least daily_signin and one other task
  if (tasks.daily_signin && Object.keys(tasks).length >= 2) {
    return { type: 'ok', tasks };
  }

  // Build shape skeleton for diagnostics
  function buildShape(obj, depth) {
    if (depth > 6 || !obj || typeof obj !== 'object') return null;
    if (Array.isArray(obj)) {
      return obj.length > 0 ? [buildShape(obj[0], depth + 1)] : [];
    }
    const shape = {};
    for (const key of Object.keys(obj)) {
      shape[key] = '<redacted>';
    }
    return shape;
  }

  return { type: 'schema_changed', shape: buildShape(payload, 0) };
}

// ============================================================================
// Signin Analyzer
// ============================================================================

function analyzeSigninResponse(result) {
  const classification = classifyTransport(result);
  if (classification !== 'ok') {
    // 通知里只放分类与状态码；脱敏后的响应预览留给日志排查
    return { type: classification, message: `${classification}（HTTP ${result.statusCode}）` };
  }

  const { payload } = result;
  if (!payload) {
    return { type: 'schema_changed', message: 'No payload' };
  }

  const code = getPayloadCode(payload);
  const message = getMessage(payload);

  // Already checked: 406008 or message含"已签到"
  if (code === 406008 || message.includes('已签到')) {
    return { type: 'already_checked' };
  }

  if (isSuccessPayload(payload)) {
    const data = payload.data || payload;
    return {
      type: 'success',
      pointsEarned: firstFinite(data.points_earned, data.pointsEarned),
      streakBonus: firstFinite(data.streak_bonus, data.streakBonus),
      consecutiveDays: firstFinite(data.consecutive_days, data.consecutiveDays, data.streak),
      balance: firstFinite(data.points_balance, data.total_points, data.points, data.balance),
      message: message || '签到成功',
    };
  }

  return { type: 'api_error', message: message || `code ${code}` };
}

// ============================================================================
// Mutation Analyzer (rate/favorite/unfavorite/share)
// ============================================================================

function analyzeMutationResponse(result) {
  const classification = classifyTransport(result);
  if (classification !== 'ok') {
    return classification;
  }

  const { payload } = result;
  if (!payload) {
    return 'schema_changed';
  }

  if (isSuccessPayload(payload)) {
    return 'ok';
  }

  const message = getMessage(payload);
  const lowerMessage = message.toLowerCase();

  // Skip patterns: already done for this ID
  if (/已评分|已收藏|already|重复/.test(lowerMessage)) {
    return 'skip';
  }

  // Limit patterns: task done
  if (/上限|已达|已完成|次数|limit|reached/.test(lowerMessage)) {
    return 'limit';
  }

  // Other non-success 2xx
  return 'api_error';
}

// ============================================================================
// Sampler
// ============================================================================

function createFrameIdSampler(config, random = Math.random) {
  const min = config.frameIdMax - config.frameIdSpan;
  const max = config.frameIdMax;
  const used = new Set();

  return {
    next() {
      if (used.size >= config.frameIdSpan) {
        return null; // exhausted
      }
      let attempts = 0;
      let id;
      do {
        id = Math.floor(min + random() * (max - min + 1));
        attempts++;
        if (attempts > config.frameIdSpan * 2) {
          // Prevent infinite loop in tests with fixed random
          return null;
        }
      } while (used.has(id));
      used.add(id);
      return id;
    },
  };
}

// ============================================================================
// Helpers
// ============================================================================

function pause(minMs = PAUSE_MIN_MS, maxMs = PAUSE_MAX_MS, sleep = defaultSleep) {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return sleep(ms);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatShanghaiTime(date = new Date()) {
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

// ============================================================================
// Task Executors
// ============================================================================

async function fetchProfile(ctx) {
  const { config, state, request } = ctx;
  const result = await request(config, state, '/api/user/profile', { method: 'GET' });
  const classification = classifyTransport(result);

  if (classification === 'auth_failed') {
    throw new WhosDailyError('登录失败，请更新 WHOS_COOKIE', {
      type: 'auth_failed',
      statusCode: result.statusCode,
      path: '/api/user/profile',
    });
  }

  if (classification !== 'ok') {
    throw new WhosDailyError(`会话验证失败: ${classification}`, {
      type: classification,
      statusCode: result.statusCode,
      path: '/api/user/profile',
    });
  }

  const data = result.payload?.data || result.payload || {};
  const username = firstString(data.nickname, data.username, data.name, data.email) || '未知用户';
  return username;
}

async function fetchTasks(ctx) {
  const { config, state, request, log } = ctx;
  const result = await request(config, state, '/api/user/tasks', { method: 'GET' });
  const classification = classifyTransport(result);

  if (classification === 'auth_failed') {
    throw new WhosDailyError('获取任务进度失败：登录失效', { type: 'auth_failed' });
  }

  if (classification !== 'ok') {
    log(`${LOG_PREFIX} 任务进度接口异常: ${classification}，进入盲做模式`);
    return { mode: 'blind', tasks: {} };
  }

  const analysis = analyzeTasksResponse(result.payload);
  if (analysis.type === 'ok') {
    log(`${LOG_PREFIX} 任务进度（progress 模式）: ${JSON.stringify(analysis.tasks)}`);
    return { mode: 'progress', tasks: analysis.tasks };
  } else {
    log(`${LOG_PREFIX} 任务进度结构未识别（${JSON.stringify(analysis.shape)}），进入盲做模式`);
    return { mode: 'blind', tasks: {} };
  }
}

async function doSignin(ctx) {
  const { config, state, request, tasks, summary, log, mode } = ctx;

  // Check if already done
  if (mode === 'progress' && tasks.daily_signin) {
    const { current, max } = tasks.daily_signin;
    if (current >= max) {
      log(`${LOG_PREFIX} 签到: 已完成 (${current}/${max})`);
      summary.signin = { type: 'already_checked', current, max };
      return;
    }
  }

  log(`${LOG_PREFIX} 执行签到...`);
  const result = await request(config, state, '/api/user/tasks/signin', { method: 'POST' });
  const analysis = analyzeSigninResponse(result);

  if (analysis.type === 'success') {
    log(`${LOG_PREFIX} 签到成功: +${analysis.pointsEarned} 积分，连续 ${analysis.consecutiveDays} 天`);
    summary.signin = analysis;
  } else if (analysis.type === 'already_checked') {
    // 406008 = 今日已签到，属于幂等成功，不算失败
    log(`${LOG_PREFIX} 签到: 今日已签到`);
    summary.signin = analysis;
  } else {
    summary.signin = { type: 'failed', error: analysis.type, message: analysis.message };
    if (isFatalType(analysis.type)) {
      throw new WhosDailyError(`签到遇 ${analysis.type}，终止后续写操作`, { type: analysis.type });
    }
    log(`${LOG_PREFIX} 签到失败: ${analysis.type}，继续后续任务`);
  }
}

function isFatalType(type) {
  return type === 'auth_failed' || type === 'challenge_required';
}

// 任务循环内的单次写请求：超时/socket 错误不再抛出，而是归为 'network_error' 交给调用方按"本次尝试失败"处理，
// 避免一次瞬时超时中断整个循环；其他错误（含致命类型）照常抛出
async function requestMutation(ctx, apiPath, options = {}) {
  const { config, state, request, log } = ctx;
  try {
    const result = await request(config, state, apiPath, options);
    return { result, analysis: analyzeMutationResponse(result) };
  } catch (error) {
    if (error.type !== 'network_error') throw error;
    log(`${LOG_PREFIX} ${options.method || 'GET'} ${apiPath} 网络错误: ${scrubText(error.message)}`);
    return { result: null, analysis: 'network_error' };
  }
}

function consecutiveErrorMessage(type) {
  return type === 'network_error'
    ? `连续 ${MAX_CONSECUTIVE_ERRORS} 次网络错误（超时/连接失败），请检查网络后重跑`
    : `连续 ${MAX_CONSECUTIVE_ERRORS} 次 ${type}`;
}

async function doRateAndFavorite(ctx) {
  const { config, tasks, summary, log, mode, sleep, random } = ctx;

  let ratingNeeded = 5;
  let favoriteNeeded = 5;

  if (mode === 'progress') {
    if (tasks.task_frame_rating) {
      const { current, max } = tasks.task_frame_rating;
      ratingNeeded = Math.max(0, max - current);
      if (ratingNeeded === 0) {
        log(`${LOG_PREFIX} 评分: 已完成 (${current}/${max})`);
        summary.rating = { type: 'already', current, max };
      }
    }
    if (tasks.task_favorite_content) {
      const { current, max } = tasks.task_favorite_content;
      favoriteNeeded = Math.max(0, max - current);
      if (favoriteNeeded === 0) {
        log(`${LOG_PREFIX} 收藏: 已完成 (${current}/${max})`);
        summary.favorite = { type: 'already', current, max, kept: false };
      }
    }
  }

  if (ratingNeeded === 0 && favoriteNeeded === 0) {
    return;
  }

  const sampler = createFrameIdSampler(config, random);
  const favorited = [];
  // 提前挂到 ctx：即使循环中途抛出，取消收藏步骤也能拿到已收藏列表
  ctx.favorited = favorited;
  let ratingCount = 0;
  let favoriteCount = 0;
  let attempts = 0;
  let consecutiveErrors = 0;

  log(`${LOG_PREFIX} 开始评分/收藏循环（评分需 ${ratingNeeded}，收藏需 ${favoriteNeeded}，预算 ${MAX_CANDIDATE_ATTEMPTS} 次尝试）`);

  while ((ratingCount < ratingNeeded || favoriteCount < favoriteNeeded) && attempts < MAX_CANDIDATE_ATTEMPTS) {
    attempts++;
    const frameId = sampler.next();
    if (!frameId) {
      log(`${LOG_PREFIX} 采样器耗尽`);
      break;
    }

    let anySuccess = false;

    // Try favorite first if needed
    if (favoriteCount < favoriteNeeded) {
      await pause(PAUSE_MIN_MS, PAUSE_MAX_MS, sleep);
      const { result: favResult, analysis: favAnalysis } = await requestMutation(ctx, `/api/frames/${frameId}/favorite`, { method: 'POST' });

      if (favAnalysis === 'ok') {
        favoriteCount++;
        favorited.push(frameId);
        log(`${LOG_PREFIX} 收藏 frame ${frameId} 成功 (${favoriteCount}/${favoriteNeeded})`);
        anySuccess = true;
        consecutiveErrors = 0;
      } else if (favAnalysis === 'not_found') {
        // Skip this id entirely
        continue;
      } else if (favAnalysis === 'skip') {
        // Already favorited, continue to rating
      } else if (favAnalysis === 'limit') {
        log(`${LOG_PREFIX} 收藏已达上限`);
        favoriteNeeded = favoriteCount;
      } else if (favAnalysis === 'rate_limited') {
        const retryMs = getRetryAfterMs(favResult);
        log(`${LOG_PREFIX} 收藏遇 429，休眠 ${retryMs / 1000}s 后重试`);
        await sleep(retryMs);
        const { analysis: retryAnalysis } = await requestMutation(ctx, `/api/frames/${frameId}/favorite`, { method: 'POST' });
        if (retryAnalysis === 'ok') {
          favoriteCount++;
          favorited.push(frameId);
          log(`${LOG_PREFIX} 收藏 frame ${frameId} 重试成功 (${favoriteCount}/${favoriteNeeded})`);
          anySuccess = true;
          consecutiveErrors = 0;
        } else if (retryAnalysis === 'rate_limited') {
          log(`${LOG_PREFIX} 收藏第二次 429，任务失败`);
          summary.favorite = { type: 'failed', error: 'rate_limited', current: favoriteCount, max: favoriteNeeded, message: '频率限制' };
          favoriteNeeded = favoriteCount;
        } else {
          log(`${LOG_PREFIX} 收藏重试失败: ${retryAnalysis}`);
        }
      } else if (['auth_failed', 'challenge_required'].includes(favAnalysis)) {
        throw new WhosDailyError(`收藏遇 ${favAnalysis}，终止`, { type: favAnalysis });
      } else if (favAnalysis === 'api_error' || favAnalysis === 'network_error') {
        consecutiveErrors++;
        log(`${LOG_PREFIX} 收藏 frame ${frameId} ${favAnalysis} (连续 ${consecutiveErrors})`);
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          log(`${LOG_PREFIX} 连续 ${MAX_CONSECUTIVE_ERRORS} 次错误，收藏任务中断`);
          summary.favorite = { type: 'failed', error: favAnalysis, current: favoriteCount, max: favoriteNeeded, message: consecutiveErrorMessage(favAnalysis) };
          favoriteNeeded = favoriteCount;
        }
      }
    }

    // Try rating if needed
    if (ratingCount < ratingNeeded) {
      await pause(PAUSE_MIN_MS, PAUSE_MAX_MS, sleep);
      const { result: rateResult, analysis: rateAnalysis } = await requestMutation(ctx, `/api/frames/${frameId}/rate`, { method: 'POST', body: { score: config.rateScore } });

      if (rateAnalysis === 'ok') {
        ratingCount++;
        log(`${LOG_PREFIX} 评分 frame ${frameId} 成功 (${ratingCount}/${ratingNeeded})`);
        anySuccess = true;
        consecutiveErrors = 0;
      } else if (rateAnalysis === 'not_found') {
        // Skip (but we already tried favorite, so this shouldn't happen often)
      } else if (rateAnalysis === 'skip') {
        // Already rated
      } else if (rateAnalysis === 'limit') {
        log(`${LOG_PREFIX} 评分已达上限`);
        ratingNeeded = ratingCount;
      } else if (rateAnalysis === 'rate_limited') {
        const retryMs = getRetryAfterMs(rateResult);
        log(`${LOG_PREFIX} 评分遇 429，休眠 ${retryMs / 1000}s 后重试`);
        await sleep(retryMs);
        const { analysis: retryAnalysis } = await requestMutation(ctx, `/api/frames/${frameId}/rate`, { method: 'POST', body: { score: config.rateScore } });
        if (retryAnalysis === 'ok') {
          ratingCount++;
          log(`${LOG_PREFIX} 评分 frame ${frameId} 重试成功 (${ratingCount}/${ratingNeeded})`);
          anySuccess = true;
          consecutiveErrors = 0;
        } else if (retryAnalysis === 'rate_limited') {
          log(`${LOG_PREFIX} 评分第二次 429，任务失败`);
          summary.rating = { type: 'failed', error: 'rate_limited', current: ratingCount, max: ratingNeeded, message: '频率限制' };
          ratingNeeded = ratingCount;
        } else {
          log(`${LOG_PREFIX} 评分重试失败: ${retryAnalysis}`);
        }
      } else if (['auth_failed', 'challenge_required'].includes(rateAnalysis)) {
        throw new WhosDailyError(`评分遇 ${rateAnalysis}，终止`, { type: rateAnalysis });
      } else if (rateAnalysis === 'api_error' || rateAnalysis === 'network_error') {
        consecutiveErrors++;
        log(`${LOG_PREFIX} 评分 frame ${frameId} ${rateAnalysis} (连续 ${consecutiveErrors})`);
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          log(`${LOG_PREFIX} 连续 ${MAX_CONSECUTIVE_ERRORS} 次错误，评分任务中断`);
          summary.rating = { type: 'failed', error: rateAnalysis, current: ratingCount, max: ratingNeeded, message: consecutiveErrorMessage(rateAnalysis) };
          ratingNeeded = ratingCount;
        }
      }
    }
  }

  // Summarize
  if (!summary.rating) {
    if (ratingCount >= ratingNeeded) {
      summary.rating = { type: 'done', current: ratingCount, max: ratingNeeded, attempts };
    } else {
      summary.rating = { type: 'partial', current: ratingCount, max: ratingNeeded, attempts, message: `候选 ID 已用尽（${attempts} 次尝试，命中 ${ratingCount} 个）` };
    }
  }

  if (!summary.favorite) {
    if (favoriteCount >= favoriteNeeded) {
      summary.favorite = { type: 'done', current: favoriteCount, max: favoriteNeeded, attempts, kept: false };
    } else {
      summary.favorite = { type: 'partial', current: favoriteCount, max: favoriteNeeded, attempts, kept: false, message: `候选 ID 已用尽（${attempts} 次尝试，命中 ${favoriteCount} 个）` };
    }
  }
}

async function doUnfavorite(ctx) {
  const { config, state, request, summary, log, mode, sleep } = ctx;

  const favorited = ctx.favorited || [];
  if (favorited.length === 0) {
    log(`${LOG_PREFIX} 取消收藏: 本轮未新增收藏，无需操作`);
    return;
  }

  if (config.keepFavorites) {
    log(`${LOG_PREFIX} 取消收藏: WHOS_KEEP_FAVORITES=true，跳过`);
    summary.favorite.kept = true;
    summary.favorite.keptReason = 'WHOS_KEEP_FAVORITES=true';
    return;
  }

  if (mode !== 'progress') {
    // 盲做模式读不到服务端进度，无法验证取消收藏是否会扣回任务，保守保留
    log(`${LOG_PREFIX} 取消收藏: 盲做模式下跳过（无法验证安全）`);
    summary.favorite.kept = true;
    summary.favorite.keptReason = '盲做模式无法验证取消是否扣回进度';
    return;
  }

  log(`${LOG_PREFIX} 取消收藏: 开始安全协议（共 ${favorited.length} 个）`);

  // Re-fetch tasks to get current favorite count
  const tasksResult = await fetchTasks(ctx);
  if (tasksResult.mode !== 'progress' || !tasksResult.tasks.task_favorite_content) {
    log(`${LOG_PREFIX} 取消收藏: 无法读取进度，保留收藏`);
    summary.favorite.kept = true;
    summary.favorite.keptReason = '无法验证安全';
    return;
  }

  const before = tasksResult.tasks.task_favorite_content.current;
  log(`${LOG_PREFIX} 取消收藏前进度: ${before}`);

  // Unfavorite the first one
  await pause(PAUSE_MIN_MS, PAUSE_MAX_MS, sleep);
  const firstId = favorited[0];
  const unfavResult = await request(config, state, `/api/frames/${firstId}/unfavorite`, { method: 'POST' });
  const unfavAnalysis = analyzeMutationResponse(unfavResult);

  if (unfavAnalysis !== 'ok' && unfavAnalysis !== 'skip') {
    log(`${LOG_PREFIX} 取消收藏失败: ${unfavAnalysis}，保留收藏`);
    summary.favorite.kept = true;
    summary.favorite.keptReason = `取消失败 (${unfavAnalysis})`;
    return;
  }

  // Re-fetch to check if progress dropped
  await pause(PAUSE_MIN_MS, PAUSE_MAX_MS, sleep);
  const afterResult = await fetchTasks(ctx);
  if (afterResult.mode !== 'progress' || !afterResult.tasks.task_favorite_content) {
    log(`${LOG_PREFIX} 取消收藏后无法读取进度，保留收藏`);
    // Try to re-favorite
    await pause(PAUSE_MIN_MS, PAUSE_MAX_MS, sleep);
    await request(config, state, `/api/frames/${firstId}/favorite`, { method: 'POST' });
    summary.favorite.kept = true;
    summary.favorite.keptReason = '验证后无法读取进度';
    return;
  }

  const after = afterResult.tasks.task_favorite_content.current;
  log(`${LOG_PREFIX} 取消收藏后进度: ${after}`);

  if (after < before) {
    log(`${LOG_PREFIX} 取消收藏会扣回任务进度，恢复收藏并保留`);
    await pause(PAUSE_MIN_MS, PAUSE_MAX_MS, sleep);
    await request(config, state, `/api/frames/${firstId}/favorite`, { method: 'POST' });
    summary.favorite.kept = true;
    summary.favorite.keptReason = '取消会扣回任务进度';
    return;
  }

  // Safe to unfavorite the rest
  log(`${LOG_PREFIX} 取消收藏安全，继续取消剩余 ${favorited.length - 1} 个`);
  for (let i = 1; i < favorited.length; i++) {
    await pause(PAUSE_MIN_MS, PAUSE_MAX_MS, sleep);
    const id = favorited[i];
    const result = await request(config, state, `/api/frames/${id}/unfavorite`, { method: 'POST' });
    const analysis = analyzeMutationResponse(result);
    if (analysis === 'ok' || analysis === 'skip') {
      log(`${LOG_PREFIX} 取消收藏 frame ${id} 成功`);
    } else {
      log(`${LOG_PREFIX} 取消收藏 frame ${id} 失败: ${analysis}（继续）`);
    }
  }

  log(`${LOG_PREFIX} 取消收藏完成，收藏夹保持干净`);
  summary.favorite.kept = false;
}

async function doShare(ctx) {
  const { tasks, summary, log, mode, sleep } = ctx;

  let shareNeeded = 5;
  if (mode === 'progress' && tasks.task_share) {
    const { current, max } = tasks.task_share;
    shareNeeded = Math.max(0, max - current);
    if (shareNeeded === 0) {
      log(`${LOG_PREFIX} 分享: 已完成 (${current}/${max})`);
      summary.share = { type: 'already', current, max };
      return;
    }
  }

  log(`${LOG_PREFIX} 执行分享任务（需 ${shareNeeded} 次）`);
  let shareCount = 0;
  let consecutiveErrors = 0;

  // 网络错误不计入分享次数，只累计连续错误；其他分支要么计数、要么 break，循环有界
  while (shareCount < shareNeeded) {
    await pause(PAUSE_MIN_MS, PAUSE_MAX_MS, sleep);
    const { result, analysis } = await requestMutation(ctx, '/api/user/tasks/task_share/complete', { method: 'POST' });

    if (analysis === 'ok') {
      shareCount++;
      consecutiveErrors = 0;
      log(`${LOG_PREFIX} 分享 (${shareCount}/${shareNeeded}) 成功`);
    } else if (analysis === 'limit') {
      log(`${LOG_PREFIX} 分享已达上限`);
      break;
    } else if (analysis === 'rate_limited') {
      const retryMs = getRetryAfterMs(result);
      log(`${LOG_PREFIX} 分享遇 429，休眠 ${retryMs / 1000}s 后重试`);
      await sleep(retryMs);
      const { analysis: retryAnalysis } = await requestMutation(ctx, '/api/user/tasks/task_share/complete', { method: 'POST' });
      if (retryAnalysis === 'ok') {
        shareCount++;
        consecutiveErrors = 0;
        log(`${LOG_PREFIX} 分享 (${shareCount}/${shareNeeded}) 重试成功`);
      } else if (retryAnalysis === 'rate_limited') {
        log(`${LOG_PREFIX} 分享第二次 429，任务失败`);
        summary.share = { type: 'failed', error: 'rate_limited', current: shareCount, max: shareNeeded, message: '频率限制' };
        break;
      } else {
        log(`${LOG_PREFIX} 分享重试失败: ${retryAnalysis}`);
        summary.share = { type: 'failed', error: retryAnalysis, current: shareCount, max: shareNeeded };
        break;
      }
    } else if (isFatalType(analysis)) {
      summary.share = { type: 'failed', error: analysis, current: shareCount, max: shareNeeded };
      throw new WhosDailyError(`分享遇 ${analysis}，终止后续写操作`, { type: analysis });
    } else if (analysis === 'network_error') {
      consecutiveErrors++;
      if (consecutiveErrors < MAX_CONSECUTIVE_ERRORS) {
        log(`${LOG_PREFIX} 分享 network_error (连续 ${consecutiveErrors})，重试`);
        continue;
      }
      log(`${LOG_PREFIX} 连续 ${MAX_CONSECUTIVE_ERRORS} 次网络错误，分享任务中断`);
      summary.share = { type: 'failed', error: analysis, current: shareCount, max: shareNeeded, message: consecutiveErrorMessage(analysis) };
      break;
    } else {
      log(`${LOG_PREFIX} 分享失败: ${analysis}`);
      summary.share = { type: 'failed', error: analysis, current: shareCount, max: shareNeeded };
      break;
    }
  }

  if (!summary.share) {
    summary.share = { type: 'done', current: shareCount, max: shareNeeded };
  }
}

// ============================================================================
// Orchestration
// ============================================================================

async function run(config, args, deps = {}) {
  const request = deps.request || requestJson;
  const sleep = deps.sleep || defaultSleep;
  const random = deps.random || Math.random;
  const log = deps.log || console.log;

  const state = { cookies: parseCookieJar(config.cookie) };

  const summary = {
    user: '',
    signin: null,
    rating: null,
    favorite: null,
    share: null,
    mode: 'unknown',
    errors: [],
  };

  const recordError = (stage, error) => {
    summary.errors.push({
      stage,
      type: error.type || 'runtime_error',
      message: scrubText(error.message),
    });
  };

  // Step 1: 会话验证失败（含登录失效）直接返回，不做任何写操作
  log(`${LOG_PREFIX} 验证会话...`);
  try {
    summary.user = await fetchProfile({ config, state, request, log });
  } catch (error) {
    recordError('profile', error);
    return summary;
  }
  log(`${LOG_PREFIX} ✅ 会话验证成功: ${summary.user}`);

  // Step 2: 任务进度
  log(`${LOG_PREFIX} 获取任务进度...`);
  let mode;
  let tasks;
  try {
    ({ mode, tasks } = await fetchTasks({ config, state, request, log }));
  } catch (error) {
    recordError('tasks', error);
    return summary;
  }
  summary.mode = mode;

  if (args.statusOnly) {
    log(`${LOG_PREFIX} --status-only 模式，仅显示进度:`);
    log(`${LOG_PREFIX} 模式: ${mode}`);
    log(`${LOG_PREFIX} 任务: ${JSON.stringify(tasks, null, 2)}`);
    return summary;
  }

  const ctx = { config, state, request, tasks, summary, log, mode, sleep, random };

  // 单个任务的非致命失败只记录并继续；auth_failed / challenge_required 为致命，停止后续写操作
  const steps = [
    ['signin', async () => { await pause(PAUSE_MIN_MS, PAUSE_MAX_MS, sleep); await doSignin(ctx); }],
    ['rate_favorite', () => doRateAndFavorite(ctx)],
    ['unfavorite', () => doUnfavorite(ctx)],
    ['share', async () => { await pause(PAUSE_MIN_MS, PAUSE_MAX_MS, sleep); await doShare(ctx); }],
  ];

  let fatal = null;
  for (const [stage, step] of steps) {
    if (fatal) break;
    try {
      await step();
    } catch (error) {
      recordError(stage, error);
      // 取消收藏中途异常：账号里仍留有本轮收藏，通知里如实标记为"已保留"
      if (stage === 'unfavorite' && summary.favorite) {
        summary.favorite.kept = true;
        summary.favorite.keptReason = `取消收藏中断（${error.type || 'runtime_error'}）`;
      }
      if (isFatalType(error.type)) {
        fatal = error.type;
        log(`${LOG_PREFIX} ❌ ${stage} 阶段遇 ${fatal}，停止后续写操作`);
      } else {
        log(`${LOG_PREFIX} ❌ ${stage} 阶段失败: ${scrubText(error.message)}，继续后续任务`);
      }
    }
  }

  // 未执行到的任务标记为失败，避免通知里出现空缺
  if (!summary.rating) summary.rating = { type: 'failed', error: fatal || 'skipped', message: '未执行' };
  if (!summary.favorite) summary.favorite = { type: 'failed', error: fatal || 'skipped', kept: false, message: '未执行' };
  if (!summary.share) summary.share = { type: 'failed', error: fatal || 'skipped', message: '未执行' };

  // Step 7: 进度模式下复核，以服务端数值为准
  if (mode === 'progress' && !fatal) {
    try {
      await pause(PAUSE_MIN_MS, PAUSE_MAX_MS, sleep);
      const finalTasks = await fetchTasks(ctx);
      if (finalTasks.mode === 'progress') {
        const pairs = [
          ['daily_signin', summary.signin],
          ['task_frame_rating', summary.rating],
          ['task_favorite_content', summary.favorite],
          ['task_share', summary.share],
        ];
        for (const [key, entry] of pairs) {
          if (finalTasks.tasks[key] && entry) {
            entry.current = finalTasks.tasks[key].current;
            entry.max = finalTasks.tasks[key].max;
          }
        }
      }
    } catch (error) {
      recordError('verify', error);
    }
  }

  return summary;
}

// ============================================================================
// Result Formatting
// ============================================================================

function formatResult(summary) {
  const lines = [];
  lines.push(`账号: ${summary.user || '未知'}`);

  const fatal = summary.errors.find(e => e.type === 'auth_failed');
  if (fatal && !summary.signin) {
    lines.push('❌ 登录失败，请更新 WHOS_COOKIE');
    return lines.join('\n');
  }

  // Signin
  if (summary.signin) {
    if (summary.signin.type === 'success') {
      const bonus = summary.signin.streakBonus > 0 ? `（含连续奖励 ${summary.signin.streakBonus}）` : '';
      lines.push(`✅ 签到成功：+${summary.signin.pointsEarned} 积分${bonus} · 连续 ${summary.signin.consecutiveDays} 天`);
    } else if (summary.signin.type === 'already_checked') {
      lines.push('⏭️ 签到: 今日已签到');
    } else {
      lines.push(`❌ 签到失败: ${summary.signin.message || summary.signin.error}`);
    }
  }

  // Rating
  if (summary.rating) {
    const { type, current, max, attempts, message } = summary.rating;
    if (type === 'done') {
      lines.push(`✅ 评分 ${current}/${max}${attempts ? `（尝试 ${attempts} 个候选帧）` : ''}`);
    } else if (type === 'already') {
      lines.push(`⏭️ 评分 ${current}/${max}`);
    } else if (type === 'partial') {
      lines.push(`❌ 评分部分完成 ${current}/${max}：${message}`);
    } else {
      lines.push(`❌ 评分失败 ${current || 0}/${max || 5}: ${message || summary.rating.error}`);
    }
  }

  // Favorite
  if (summary.favorite) {
    const { type, current, max, kept, keptReason, message } = summary.favorite;
    if (type === 'done') {
      if (kept) {
        lines.push(`✅ 收藏 ${current}/${max}（已保留收藏：${keptReason}）`);
      } else {
        lines.push(`✅ 收藏 ${current}/${max}（已取消收藏，收藏夹保持干净）`);
      }
    } else if (type === 'already') {
      lines.push(`⏭️ 收藏 ${current}/${max}`);
    } else if (type === 'partial') {
      lines.push(`❌ 收藏部分完成 ${current}/${max}：${message}`);
    } else {
      lines.push(`❌ 收藏失败 ${current || 0}/${max || 5}: ${message || summary.favorite.error}`);
    }
  }

  // Share
  if (summary.share) {
    const { type, current, max, message } = summary.share;
    if (type === 'done') {
      lines.push(`✅ 分享 ${current}/${max}`);
    } else if (type === 'already') {
      lines.push(`⏭️ 分享 ${current}/${max}`);
    } else {
      lines.push(`❌ 分享失败 ${current || 0}/${max || 5}: ${message || summary.share.error}`);
    }
  }

  // Balance
  if (summary.signin && summary.signin.balance > 0) {
    lines.push(`📊 当前积分: ${summary.signin.balance}`);
  }

  // Warnings
  if (summary.mode === 'blind') {
    lines.push(`⚠️ 进度接口结构未识别（schema_changed），请维护`);
  }

  if (summary.errors.length > 0) {
    lines.push('\n错误详情:');
    for (const err of summary.errors) {
      lines.push(`  [${err.stage}] ${err.type}: ${err.message}`);
    }
    if (summary.errors.some(e => e.type === 'auth_failed')) {
      lines.push('请更新环境变量 WHOS_COOKIE');
    }
  }

  return lines.join('\n');
}

function decideExitCode(summary) {
  const FATAL_TYPES = ['auth_failed', 'challenge_required', 'network_error', 'config_error', 'schema_changed'];
  if (summary.errors.some(e => FATAL_TYPES.includes(e.type))) {
    return 1;
  }

  const tasks = [summary.signin, summary.rating, summary.favorite, summary.share];
  for (const task of tasks) {
    if (task && (task.type === 'failed' || task.type === 'partial')) {
      return 1;
    }
  }

  return 0;
}

// ============================================================================
// Notification
// ============================================================================

async function sendNotification(title, body) {
  try {
    const sendNotify = require('./sendNotify');
    let notifier = sendNotify;
    if (typeof sendNotify === 'object' && sendNotify.sendNotify) {
      notifier = sendNotify.sendNotify;
    } else if (sendNotify.default) {
      notifier = sendNotify.default;
    }

    if (typeof notifier === 'function') {
      await Promise.resolve(notifier(title, body));
    } else {
      console.log(`${LOG_PREFIX} [通知] ${title}\n${body}`);
    }
  } catch (error) {
    console.log(`${LOG_PREFIX} [通知失败，输出到控制台] ${title}\n${body}`);
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  let notified = false;
  try {
    const args = parseArgs(process.argv);

    if (args.help) {
      printUsage();
      return;
    }

    loadDotEnv();
    const config = getConfig();
    console.log(`${LOG_PREFIX} 开始执行 - ${formatShanghaiTime()}`);

    const summary = await run(config, args);

    if (args.statusOnly) {
      console.log(`${LOG_PREFIX} 📊 只读模式结束，未执行任何写操作`);
      process.exitCode = summary.errors.length > 0 ? 1 : 0;
      return;
    }

    const resultText = formatResult(summary);
    console.log(`\n${LOG_PREFIX} ========== 执行结果 ==========`);
    console.log(resultText);

    await sendNotification(TASK_TITLE, resultText);
    notified = true;

    process.exitCode = decideExitCode(summary);
  } catch (error) {
    console.error(`${LOG_PREFIX} ❌ 执行失败: ${scrubText(error.message)}`);

    if (!notified && error.type !== 'config_error') {
      const failureText = `❌ 执行失败\n\n错误类型: ${error.type || 'runtime_error'}\n错误信息: ${scrubText(error.message)}`;
      await sendNotification(TASK_TITLE, failureText).catch(() => {});
    }

    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`${LOG_PREFIX} 未捕获错误:`, scrubText(err.message));
    process.exitCode = 1;
  });
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  WhosDailyError,
  getConfig,
  parseArgs,
  normalizeCookie,
  normalizeBaseUrl,
  scrubText,
  mergeSetCookie,
  parseCookieJar,
  requestJson,
  classifyTransport,
  getRetryAfterMs,
  isSuccessPayload,
  getMessage,
  getPayloadCode,
  firstFinite,
  firstString,
  analyzeTasksResponse,
  analyzeSigninResponse,
  analyzeMutationResponse,
  createFrameIdSampler,
  formatResult,
  decideExitCode,
  run,
};
