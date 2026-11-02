#!/usr/bin/env node
// cron: 5 8 * * *
// new Env('AgentRouter 签到');
// description: AgentRouter 公益站每日签到（本站没有独立签到接口，登录动作即签到）：账密登录 → 日志核验 → 余额 → 青龙通知
//
// 环境变量：
//   AGENTROUTER_ACCOUNTS   必需，JSON 数组：[{"name":"主号","username":"邮箱或用户名","password":"密码"}]
//   AGENTROUTER_BASE_URL   可选，默认 https://ps.air-outer.com（另一可用域名 https://agentrouter.org）
//   AGENTROUTER_TIMEOUT_MS 可选，默认 20000（允许 1000~120000）
//   AGENTROUTER_PUSH       可选，0 = 只打面板日志、不发通知
//
// 站点事实（2026-11 实测，改判定逻辑前先读完）：
//   * 本站是 New-API 分支，没有 /api/user/checkin、/api/user/sign_in 等签到路由（实测全部 404）；
//     签到由登录 / 注册 / OAuth 回调触发，前端也只有登录后的 toast「签到成功，新增额度已到账」。
//   * 登录响应里的 checked_in 是「今日是否已签到」的状态位，**不是**「本次签到成功」的证据：
//     当天已签过的账号再次登录同样返回 true。只凭它判成功 = 永久误报。
//   * 登录响应里的 data.quota 实测可能为 0，余额必须再查 GET /api/user/self（唯一可信来源）。
//   * 唯一硬判据是 GET /api/log/self 里「北京时间今天」的签到记录（type=4 或含「签到成功」），
//     且 created_at*1000 >= 本次运行开始 - 300s 才算「本次新签」，否则算「今日已签到」；
//     今天完全没有签到记录 → 判失败（登录成功但签到未落库）。
//   * 系统访问令牌（Authorization: Bearer …）与 Session Cookie 都不会触发签到（已实测），
//     所以本脚本只走账密登录。签到按北京时间自然日重置。
//
// 运行环境：Node.js ≥ 18（依赖全局 fetch / AbortController），除青龙 sendNotify 外无任何依赖。

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BASE_URL = 'https://ps.air-outer.com';
const QUOTA_PER_USD = 500000;
const DEFAULT_TIMEOUT_MS = 20000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 120000;
// 「本次新签」的容差窗口：容纳本机时钟偏差与请求耗时（5 分钟）
const SLACK_MS = 5 * 60 * 1000;
const ACCOUNT_DELAY_MS = [2000, 5000];
const CHECKIN_LOG_TYPE = 4;
const CHECKIN_LOG_HINT = '签到成功';
const TASK_TITLE = 'AgentRouter 签到';
const LOG_PREFIX = '[agentrouter]';

// 青龙 Node-RED「双 TG Bot 分流」关键词表（大小写不敏感，标题+正文拼接后匹配）
const ALERT_KEYWORDS = '已失效,无效用户,失效,cookie失效,ck失效,登录失效,账号失效,账号过期,重新登录,发生异常,invalid,expired';
// 进通知正文的外部文本收口：命中关键词就换成这个中性占位（占位自身必须无关键词）
const NOTICE_SAFE_PLACEHOLDER = '步骤失败(详情见面板日志)';

class AgentRouterError extends Error {
  constructor(type, message) {
    super(message);
    this.name = 'AgentRouterError';
    this.type = type;
  }
}

// ——— 脱敏 / 分流收口（与 Node-RED 侧等价；外部文本进通知前必须过一遍） ———

function redactLog(value) {
  return String(value === null || value === undefined ? '' : value)
    // key: value / key=value / JSON 的 "key":"value" 三种形态都要盖住。
    // session 单独一项：Cookie 里 `session=…` 的值就是登录态，泄漏即等于泄漏账号。
    .replace(/(["']?)(password|passwd|pwd|session|cookie|access_token|refresh_token|token|authorization|api_?key)\1\s*[:=]\s*["']?(?:Basic|Bearer)?\s*[^"',};\s]+/gi, '$1$2=[redacted]')
    // 没有 key 名的裸 Bearer 令牌
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    // 裸 JWT（没有 key 名时也要脱敏）
    .replace(/(eyJ[A-Za-z0-9_-]{10})[A-Za-z0-9_.-]+/g, '$1***');
}

function matchesAlertRouting(value) {
  const lower = String(value === null || value === undefined ? '' : value).toLowerCase();
  const compact = lower.replace(/\s+/g, '');
  return ALERT_KEYWORDS
    .split(',')
    .map(keyword => keyword.trim())
    .filter(Boolean)
    .some(keyword => lower.includes(keyword) || compact.includes(keyword.replace(/\s+/g, '')));
}

function noticeSafe(value) {
  const text = redactLog(value);
  return matchesAlertRouting(text) ? NOTICE_SAFE_PLACEHOLDER : text;
}

function maskAccount(value) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (!text) return '未知账号';

  const at = text.indexOf('@');
  if (at > 0) {
    const local = text.slice(0, at);
    const domain = text.slice(at + 1);
    // 本地部分太短时连带首字符一起隐去，否则等于没脱敏
    const head = local.length > 2 ? local.slice(0, 2) : '';
    return `${head}***@${domain}`;
  }

  return text.length > 2 ? `${text.slice(0, 4)}***` : '***';
}

// ——— 配置解析 ———

function loadDotEnv() {
  const candidates = [
    path.join(process.cwd(), '.env'),
    path.join(__dirname, '..', '.env'),
  ];

  for (const file of candidates) {
    let content = '';
    try {
      if (!fs.existsSync(file)) continue;
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const equalsIndex = trimmed.indexOf('=');
      if (equalsIndex === -1) continue;

      const key = trimmed.slice(0, equalsIndex).trim();
      let value = trimmed.slice(equalsIndex + 1).trim();
      if (!key) continue;
      // 已存在的环境变量优先，.env 不覆盖青龙面板注入的值
      if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;

      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

// Node 20+ 的 JSON.parse 错误消息会把原始输入片段回显进来（可能含账号/密码），
// 例如 `Unexpected token ']', ..."_SECRET"},]" is not valid JSON`。
// 只保留回显之前的部分（`Unexpected token ']'`），再脱敏截断。
function describeJsonParseError(error) {
  const raw = String(error && error.message ? error.message : error || '');
  const head = raw.split(/,\s*(?:\.\.\.)?\s*"/)[0];
  return redactLog(head).slice(0, 200);
}

function parseAccounts(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) {
    throw new AgentRouterError('config_missing', '未配置必需环境变量 AGENTROUTER_ACCOUNTS');
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // JSON.parse 的原文可能自带 invalid（如 Invalid \escape），进通知前先收口
    const detail = noticeSafe(describeJsonParseError(error));
    throw new AgentRouterError('config_missing', `AGENTROUTER_ACCOUNTS 不是合法的 JSON（解析错误：${detail}）`);
  }

  if (!Array.isArray(parsed)) {
    throw new AgentRouterError(
      'config_missing',
      'AGENTROUTER_ACCOUNTS 必须是 JSON 数组，例如 [{"username":"邮箱或用户名","password":"密码"}]',
    );
  }

  if (parsed.length === 0) {
    throw new AgentRouterError('config_missing', 'AGENTROUTER_ACCOUNTS 是空数组，请至少配置一个账号');
  }

  const accounts = [];
  parsed.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new AgentRouterError('config_missing', `AGENTROUTER_ACCOUNTS[${index}] 必须是对象（含 username / password）`);
    }

    const username = typeof item.username === 'string' ? item.username.trim() : '';
    const password = typeof item.password === 'string' ? item.password : '';
    const missing = [];
    if (!username) missing.push('username');
    if (!String(password).trim()) missing.push('password');
    if (missing.length > 0) {
      throw new AgentRouterError(
        'config_missing',
        `AGENTROUTER_ACCOUNTS[${index}] 缺少 ${missing.join(' / ')}（该字段不能为空）`,
      );
    }

    // 账号名属外部文本：先脱敏；命中失效分流关键词就回落到「账号N」
    // （不能拿中性占位顶替显示名 —— 那样一条成功明细也会以「步骤失败(详情见面板日志)」出现在通知里）
    const name = typeof item.name === 'string' ? redactLog(item.name.trim()) : '';
    accounts.push({
      username,
      password,
      label: name && !matchesAlertRouting(name) ? name : `账号${index + 1}`,
    });
  });

  return accounts;
}

function resolveBaseUrl() {
  const raw = String(process.env.AGENTROUTER_BASE_URL || '').trim();
  if (!raw) return DEFAULT_BASE_URL;

  const normalized = raw.replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/i.test(normalized)) {
    console.warn(`${LOG_PREFIX} ⚠️ AGENTROUTER_BASE_URL=${raw} 不是合法的 http(s) 地址，回落到默认 ${DEFAULT_BASE_URL}`);
    return DEFAULT_BASE_URL;
  }

  return normalized;
}

function resolveTimeout() {
  const raw = String(process.env.AGENTROUTER_TIMEOUT_MS || '').trim();
  if (!raw) return DEFAULT_TIMEOUT_MS;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    console.warn(
      `${LOG_PREFIX} ⚠️ AGENTROUTER_TIMEOUT_MS=${raw} 非法（允许 ${MIN_TIMEOUT_MS}~${MAX_TIMEOUT_MS}），回落到默认 ${DEFAULT_TIMEOUT_MS}ms`,
    );
    return DEFAULT_TIMEOUT_MS;
  }

  return Math.round(value);
}

function pushEnabled() {
  return String(process.env.AGENTROUTER_PUSH || '1').trim() !== '0';
}

// ——— 时间 / 余额换算 ———

function toBeijingDayKey(unixSec) {
  const ms = Number(unixSec) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return '';

  const p = (n) => String(n).padStart(2, '0');
  const date = new Date(ms + 8 * 3600 * 1000); // UTC+8 无夏令时，固定偏移即可，不依赖时区数据库
  return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}`;
}

function formatBeijingTime(unixSec) {
  const ms = Number(unixSec) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return '';

  const p = (n) => String(n).padStart(2, '0');
  const date = new Date(ms + 8 * 3600 * 1000);
  return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())} ${p(date.getUTCHours())}:${p(date.getUTCMinutes())}`;
}

function quotaToUsd(quota) {
  const value = Number(quota);
  if (!Number.isFinite(value)) return null;
  return value / QUOTA_PER_USD;
}

function formatUsdFromQuota(quota) {
  const usd = quotaToUsd(quota);
  return usd === null ? '' : `$${usd.toFixed(2)}`;
}

function formatUsdAmount(usd) {
  const value = Number(usd);
  if (!Number.isFinite(value)) return '';
  return `$${value.toFixed(2)}`;
}

// 签到记录里的额度形如「增加额度 ＄25.000000 额度」。只取数字，非数字一律丢弃
function parseRewardUsd(content) {
  const match = String(content || '').match(/增加额度\s*[＄$]?\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0 || value > 10000) return null;
  return value;
}

// ——— 判定 ———

function isCheckinLogItem(item) {
  if (!item || typeof item !== 'object') return false;
  const content = typeof item.content === 'string' ? item.content : '';
  return Number(item.type) === CHECKIN_LOG_TYPE || content.includes(CHECKIN_LOG_HINT);
}

/**
 * 从 /api/log/self 的 items 里找「北京时间今天」的签到记录。
 * - 今天的记录且 created_at*1000 >= runStartMs - SLACK_MS → level='fresh'（本次新签）
 * - 今天的记录但更早 → level='today'（今日已签到）
 * - 今天没有 → level='none'（判失败）
 * 注意：返回的 rewardUsd 已解析成数字，日志原文（外部文本）不进入通知层。
 */
function pickTodayCheckin(items, runStartMs, nowMs = Date.now()) {
  const empty = { level: 'none', at: null, rewardUsd: null };
  const list = Array.isArray(items) ? items : [];
  const todayKey = toBeijingDayKey(Math.floor(nowMs / 1000));
  if (!todayKey) return empty;

  let latest = null;
  for (const item of list) {
    if (!isCheckinLogItem(item)) continue;

    const createdAt = Number(item.created_at);
    if (!Number.isFinite(createdAt) || createdAt <= 0) continue;
    if (toBeijingDayKey(createdAt) !== todayKey) continue;

    if (!latest || createdAt > latest.createdAt) {
      latest = { createdAt, content: typeof item.content === 'string' ? item.content : '' };
    }
  }

  if (!latest) return empty;

  const fresh = latest.createdAt * 1000 >= Number(runStartMs) - SLACK_MS;
  return {
    level: fresh ? 'fresh' : 'today',
    at: latest.createdAt,
    rewardUsd: parseRewardUsd(latest.content),
  };
}

/**
 * verdict 定稿（只在这里判成败）。
 * ★ loginData.checked_in 故意不参与：它是「今日状态」而不是「本次动作」，
 *   用它兜底会让「登录成功但签到没落库」永久误报成成功。
 * ★ selfData 只提供余额，不参与成败判定；余额拿不到不影响「今天签没签到」这个事实。
 */
function decide({ logLevel } = {}) {
  if (logLevel === 'fresh') return 'success';
  if (logLevel === 'today') return 'already';
  return 'no_log';
}

function isSuccessType(type) {
  return type === 'success' || type === 'already';
}

const VERDICT_ICONS = {
  success: '✅',
  already: '⏭️',
  no_log: '⚠️',
  auth_failed: '❌',
  banned: '❌',
  network: '⚠️',
  login_rejected: '⚠️',
  exception: '⚠️',
};

function verdictIcon(type) {
  return VERDICT_ICONS[type] || '⚠️';
}

// 明细重建用（不含任何外部文本）——凭证类只在存在凭证失败时才会出现，那时不会走重建分支
const VERDICT_LABELS = {
  success: '签到成功',
  already: '今日已签到',
  no_log: '今日签到未确认',
  auth_failed: '账号凭证已失效',
  banned: '账号凭证已失效',
  network: '网络请求失败',
  login_rejected: '登录未成功',
  exception: '执行失败',
};

function verdictLabel(type) {
  return VERDICT_LABELS[type] || '执行失败';
}

// 只取站点主机名：baseUrl 来自环境变量（外部文本），整串插进通知既可能太长也可能带进关键词
function siteHostOf(baseUrl) {
  try {
    return new URL(String(baseUrl || DEFAULT_BASE_URL)).host || DEFAULT_BASE_URL;
  } catch {
    return DEFAULT_BASE_URL.replace(/^https?:\/\//, '');
  }
}

function credentialNotice(kind, baseUrl) {
  const site = siteHostOf(baseUrl);
  const reason = kind === 'banned' ? '（服务端提示账号被封禁或禁用）' : '';
  // 凭证类文案由本函数自生成、不过 noticeSafe：必须先命中「已失效 / 重新登录」才能进失效提醒 Bot
  return `❌ 账号凭证已失效${reason}，请重新登录 ${site}/login 后更新环境变量 AGENTROUTER_ACCOUNTS`;
}

function hasCredentialFailure(results) {
  return (Array.isArray(results) ? results : []).some(
    result => result && (result.type === 'auth_failed' || result.type === 'banned'),
  );
}

function buildHeadline(results) {
  const list = Array.isArray(results) ? results : [];
  const ok = list.filter(result => isSuccessType(result && result.type)).length;
  const icon = ok === list.length ? '✅' : ok === 0 ? '❌' : '⚠️';
  return `${icon} 成功 ${ok} / 共 ${list.length}`;
}

function renderAccountBlock(result, index) {
  const lines = [`${index + 1}. ${result.label}（${result.masked}）`];

  if (result.type === 'success') {
    const reward = result.rewardUsd ? `（+${formatUsdAmount(result.rewardUsd)}）` : '';
    lines.push(`   ✅ 签到成功${reward}`);
  } else if (result.type === 'already') {
    lines.push('   ⏭️ 今日已签到');
  } else if (result.type === 'auth_failed' || result.type === 'banned') {
    lines.push(`   ${credentialNotice(result.type, result.baseUrl)}`);
  } else {
    lines.push(`   ${result.detail || '⚠️ 该账号执行失败（详情见面板日志）'}`);
  }

  if (result.checkinAt && isSuccessType(result.type)) {
    lines.push(`   今日签到：${formatBeijingTime(result.checkinAt)}（北京时间）`);
  }
  if (result.quotaText) {
    lines.push(`   余额：${result.quotaText}`);
  }

  return lines.join('\n');
}

function renderControlledBlock(result, index) {
  return `${index + 1}. ${result.label}（${result.masked}） ${verdictIcon(result.type)} ${verdictLabel(result.type)}`;
}

/**
 * 组装通知，并在发送前对「标题+正文」整体跑一次分流匹配（标题也参与匹配）。
 * 命中时的回落顺序：
 *   ① 存在凭证类失败 → 这是想要的命中，原样发
 *   ② 否则剔明细重建（只用受控文本）
 *   ③ 仍命中 → 降级为最小化通知（标题 + 成功计数 + 账号序号 + 成败）
 */
function buildNotification(results) {
  const list = Array.isArray(results) ? results : [];
  const title = TASK_TITLE;
  const headline = buildHeadline(list);
  const withBlocks = (blocks) => [headline, '', ...blocks].join('\n');

  let body = withBlocks(list.map(renderAccountBlock));
  if (!matchesAlertRouting(`${title}\n${body}`)) return { title, body, tier: 0 };
  if (hasCredentialFailure(list)) return { title, body, tier: 0 };

  body = withBlocks(list.map(renderControlledBlock));
  if (!matchesAlertRouting(`${title}\n${body}`)) {
    console.warn(`${LOG_PREFIX} ⚠️ 通知正文含失效分流关键词且无凭证类失败，已剔除明细重建`);
    return { title, body, tier: 1 };
  }

  body = [headline, '', ...list.map((result, index) => `${index + 1}. ${verdictIcon(result.type)}`)].join('\n');
  console.error(`${LOG_PREFIX} ❌ ${TASK_TITLE} 通知正文仍含失效分流关键词，已降级为最小化通知（请补收口）`);
  return { title, body, tier: 2 };
}

function buildConfigMissingText(detail) {
  const guide = [
    '❌ 未配置环境变量 AGENTROUTER_ACCOUNTS',
    '请在青龙面板「环境变量」中新增该变量，值为 JSON 数组，例如：',
    '   [{"name":"主号","username":"邮箱或用户名","password":"密码"}]',
    '多个账号就往数组里再加对象（name 可选）。',
  ].join('\n');
  const text = detail ? `${guide}\n\n${detail}` : guide;
  // 配置缺失属非凭证类：用户只需补变量，不是去重登。本地兜底一遍，绝不能进失效提醒 Bot
  return matchesAlertRouting(text) ? guide : text;
}

// ——— 青龙通知（多路径查找 + 三形态兼容 + 降级） ———

function buildNotifyCandidates() {
  const dirs = [];
  // 第一遍：固定位置（脚本同目录 → 逐代向上 → cwd → 青龙标准目录）
  let dir = __dirname;
  for (let i = 0; i < 3; i += 1) {
    dirs.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  dirs.push(process.cwd(), path.join(process.cwd(), 'function'));
  dirs.push('/ql/data/scripts', '/ql/data/scripts/function', '/ql/scripts');

  const candidates = [];
  for (const item of dirs) {
    candidates.push(path.join(item, 'sendNotify.js'), path.join(item, 'notify.js'));
  }
  return [...new Set(candidates)];
}

function isSelfFile(file) {
  try {
    return fs.realpathSync(file) === fs.realpathSync(__filename);
  } catch {
    return false;
  }
}

let notifyModuleResolved = false;
let notifyModule = null;

function loadSendNotify() {
  if (notifyModuleResolved) return notifyModule;

  const candidates = buildNotifyCandidates();
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file) || isSelfFile(file)) continue;

      const mod = require(file);
      const fn = typeof mod === 'function'
        ? mod
        : typeof mod?.sendNotify === 'function'
          ? mod.sendNotify
          : typeof mod?.default === 'function'
            ? mod.default
            : null;

      if (fn) {
        notifyModule = fn;
        notifyModuleResolved = true;
        return notifyModule;
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} ⚠️ 通知模块加载失败（${path.basename(file)}）：${redactLog(error && error.message)}`);
    }
  }

  notifyModuleResolved = true;
  notifyModule = null;
  // 降级不等于静默：找不到模块必须告警一次（只打一次，且不进通知正文）
  console.warn(
    `${LOG_PREFIX} ⚠️ 未找到青龙通知模块 sendNotify.js（已搜索 ${candidates.length} 个位置），本次未发送通知，结果只输出到面板日志。请把 sendNotify.js 放到脚本同目录或 /ql/data/scripts/ 下。`,
  );
  return null;
}

async function notify(title, content) {
  if (!pushEnabled()) {
    console.log(`${LOG_PREFIX} AGENTROUTER_PUSH=0，本次不发送通知`);
    console.log(`\n${title}\n${content}`);
    return false;
  }

  try {
    const sendNotify = loadSendNotify();
    if (sendNotify) {
      await Promise.resolve(sendNotify(title, content));
      return true;
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} ❌ 青龙通知发送失败：${redactLog(error && error.message)}`);
  }

  console.log(`\n${title}\n${content}`);
  return false;
}

// ——— HTTP 层 ———

function buildHeaders({ config, cookie, userId, json }) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Origin': config.baseUrl,
    'Referer': `${config.baseUrl}/login`,
  };

  if (cookie) headers.Cookie = cookie;
  if (userId !== undefined && userId !== null && userId !== '') headers['New-Api-User'] = String(userId);
  if (json) headers['Content-Type'] = 'application/json';

  return headers;
}

function splitSetCookieHeader(header) {
  if (!header) return [];
  return String(header).split(/,(?=\s*[^;,]+=)/).map(value => value.trim()).filter(Boolean);
}

function getSetCookieHeaders(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === 'function') {
    try {
      const list = headers.getSetCookie();
      if (Array.isArray(list) && list.length > 0) return list;
    } catch {
      // 回落到单头解析
    }
  }
  return splitSetCookieHeader(typeof headers.get === 'function' ? headers.get('set-cookie') : '');
}

function extractCookieValue(headers, name) {
  for (const raw of getSetCookieHeaders(headers)) {
    const pair = String(raw).split(';')[0]?.trim();
    if (!pair) continue;

    const index = pair.indexOf('=');
    if (index <= 0) continue;
    if (pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim();
  }
  return '';
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractMessage(data) {
  return typeof data?.message === 'string' && data.message.trim()
    ? data.message.trim()
    : typeof data?.msg === 'string' && data.msg.trim()
      ? data.msg.trim()
      : typeof data?.error?.message === 'string' && data.error.message.trim()
        ? data.error.message.trim()
        : '';
}

function isAuthMessage(message) {
  const text = String(message || '').toLowerCase();
  return ['未登录', '未授权', '无权', '权限不足', '登录失效', '令牌', 'unauthorized', 'forbidden', 'invalid token', 'not logged', 'not login', 'expired']
    .some(hint => text.includes(hint));
}

async function requestJson(config, apiPath, options = {}) {
  const url = `${config.baseUrl}${apiPath}`;
  const where = `（${apiPath}）`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  if (typeof timer.unref === 'function') timer.unref(); // 只有 fetch 超时定时器可以 unref

  let response;
  let text = '';
  try {
    response = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });
    text = await response.text();
  } catch (error) {
    const timedOut = Boolean(error) && error.name === 'AbortError';
    // 驱动层错误只写面板日志（已脱敏），通知文案只用受控文本
    console.error(`${LOG_PREFIX} ⚠️ ${apiPath} 请求失败：${redactLog(timedOut ? '请求超时' : (error && error.message) || String(error))}`);
    throw new AgentRouterError(
      'network',
      timedOut
        ? `⚠️ 网络请求失败：请求超时（${config.timeoutMs}ms）${where}`
        : `⚠️ 网络请求失败：无法连接服务器${where}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const status = response.status;
  if (status === 401 || status === 403) {
    throw new AgentRouterError('auth_failed', `HTTP ${status}`);
  }
  // 4xx 一并归网络类：路由不存在时服务端回的是 {"message":"Invalid URL"}（实测 404），
  // 交给 classifyLoginFailure 会因 invalid 被误判成「凭证已失效」，反而引导用户去重置正确的账密。
  if (status >= 400) {
    // 不回显响应体：服务端文案可能自带 invalid / expired
    throw new AgentRouterError('network', `⚠️ 网络请求失败：服务端返回 HTTP ${status}${where}`);
  }

  const data = parseJsonSafe(text);
  if (!data || typeof data !== 'object') {
    throw new AgentRouterError('network', `⚠️ 网络请求失败：响应不是 JSON（HTTP ${status}）${where}`);
  }

  return { status, data, headers: response.headers };
}

// ——— 三个业务调用 ———

/**
 * 登录 = 签到触发点（本站唯一可行的签到方式）。
 * 失败分类：凭证词表 / 封禁 → auth_failed|banned（可行动：更新账密）；
 *          其余未识别返回 → login_rejected（非凭证类，不引导用户去重登）。
 */
function classifyLoginFailure(message) {
  const text = String(message || '').toLowerCase();
  const credentialHints = [
    '用户名或密码错误', '密码错误', '密码不正确', '用户不存在', '账号不存在', '未注册',
    'unauthorized', 'invalid', 'expired', '未登录', '未授权', '无权', '令牌',
  ];
  if (credentialHints.some(hint => text.includes(hint))) return 'auth_failed';

  const bannedHints = ['封禁', '禁用', 'banned', 'forbidden'];
  if (bannedHints.some(hint => text.includes(hint))) return 'banned';

  return '';
}

async function loginAccount(config, account) {
  const { status, data, headers } = await requestJson(config, '/api/user/login?turnstile=', {
    method: 'POST',
    headers: buildHeaders({ config, json: true }),
    body: JSON.stringify({ username: account.username, password: account.password }),
  });

  const message = extractMessage(data);
  if (data.success !== true) {
    const kind = classifyLoginFailure(message);
    if (kind === 'auth_failed' || kind === 'banned') {
      // 服务端 message 属外部文本：只进面板日志（已收口），通知文案由 renderSummary 自生成
      console.error(`${LOG_PREFIX} ❌ 登录被拒（HTTP ${status}）：${noticeSafe(message) || '无 message'}`);
      throw new AgentRouterError(kind, `HTTP ${status}`);
    }

    console.error(`${LOG_PREFIX} ⚠️ 登录未成功（HTTP ${status}）：${noticeSafe(message) || '无 message'}`);
    throw new AgentRouterError('login_rejected', `HTTP ${status}`);
  }

  const loginData = data.data;
  if (!loginData || typeof loginData !== 'object' || Array.isArray(loginData) || !Number.isFinite(Number(loginData.id))) {
    console.error(`${LOG_PREFIX} ⚠️ 登录响应结构未识别（缺少 data.id）`);
    throw new AgentRouterError('network', '⚠️ 登录响应缺少账号标识，站点接口可能已变更（详情见面板日志）');
  }

  return {
    data: loginData,
    id: Number(loginData.id),
    session: extractCookieValue(headers, 'session'),
  };
}

async function fetchSelf(config, session, userId) {
  const { data } = await requestJson(config, '/api/user/self', {
    headers: buildHeaders({ config, cookie: `session=${session}`, userId }),
  });

  if (data.success === true && data.data && typeof data.data === 'object') {
    return data.data;
  }

  const message = extractMessage(data);
  if (isAuthMessage(message)) {
    throw new AgentRouterError('auth_failed', '会话未被识别');
  }

  console.error(`${LOG_PREFIX} ⚠️ 余额接口返回异常：${noticeSafe(message) || '无 message'}`);
  throw new AgentRouterError('network', '⚠️ 余额接口返回异常（详情见面板日志）');
}

async function fetchLogs(config, session, userId) {
  const { data } = await requestJson(config, '/api/log/self?p=1&page_size=20', {
    headers: buildHeaders({ config, cookie: `session=${session}`, userId }),
  });

  const items = data?.data?.items;
  if (data.success === true && Array.isArray(items)) {
    return items;
  }

  const message = extractMessage(data);
  if (isAuthMessage(message)) {
    throw new AgentRouterError('auth_failed', '会话未被识别');
  }

  console.error(`${LOG_PREFIX} ⚠️ 日志接口结构未识别（schema_changed）：${noticeSafe(message) || '无 message'}`);
  throw new AgentRouterError('network', '⚠️ 日志接口结构未识别（schema_changed），请维护');
}

// ——— 单账号流程：登录 → 余额 → 日志 → 定稿 ———

function describeFailureType(error) {
  return error instanceof AgentRouterError ? error.type : 'exception';
}

async function runAccount(config, account) {
  const startedAt = Date.now();
  const base = {
    label: account.label,
    masked: maskAccount(account.username),
    baseUrl: config.baseUrl,
    type: 'exception',
    detail: '',
    quotaText: '',
    checkinAt: null,
    rewardUsd: null,
  };

  console.log(`${LOG_PREFIX} ⏳ ${base.label}（${base.masked}）：登录中（站点 ${config.baseUrl}）`);

  // ① 登录 —— 本站唯一的签到触发点
  const login = await loginAccount(config, account);
  const loginData = login.data;
  console.log(
    `${LOG_PREFIX} ✅ ${base.label}：登录成功（服务端 checked_in=${loginData.checked_in === true}，该项只表示今日状态，不作判定依据）`,
  );

  let selfData = null;
  let selfFailed = false;
  let logItems = null;
  let logFailed = false;
  const sessionMissing = !login.session;

  if (sessionMissing) {
    console.warn(`${LOG_PREFIX} ⚠️ ${base.label}：登录响应未带回 session Cookie，无法查询余额与签到日志`);
  } else {
    // ② 余额 —— 登录响应的 data.quota 实测可能为 0，不可信
    try {
      selfData = await fetchSelf(config, login.session, login.id);
      console.log(`${LOG_PREFIX} ✅ ${base.label}：余额查询成功（quota=${selfData.quota}）`);
    } catch (error) {
      selfFailed = true;
      console.warn(`${LOG_PREFIX} ⚠️ ${base.label}：余额接口失败（${describeFailureType(error)}）`);
    }

    // ③ 签到日志 —— 唯一硬判据
    try {
      logItems = await fetchLogs(config, login.session, login.id);
    } catch (error) {
      logFailed = true;
      console.warn(`${LOG_PREFIX} ⚠️ ${base.label}：签到日志接口失败（${describeFailureType(error)}）`);
    }
  }

  const checkin = logItems ? pickTodayCheckin(logItems, startedAt) : { level: 'none', at: null, rewardUsd: null };
  base.checkinAt = checkin.at || null;
  base.rewardUsd = checkin.rewardUsd || null;

  // ④ verdict 定稿：①②③ 全部跑完才判，任一步失败都不提前置成功
  if (logFailed || sessionMissing) {
    base.type = 'no_log';
    base.detail = '⚠️ 登录成功但日志接口查询失败，无法确认今日签到（详情见面板日志）';
  } else {
    base.type = decide({ loginData, selfData, logLevel: checkin.level });
    if (base.type === 'no_log') {
      base.detail = '⚠️ 登录成功但未查到今日签到记录（详情见面板日志）';
    }
  }

  // 余额：self 为唯一可信来源；self 失败时用登录响应的 quota 兜底并标注来源
  const selfQuota = Number(selfData?.quota);
  const loginQuota = Number(loginData?.quota);
  if (!selfFailed && selfData && Number.isFinite(selfQuota) && selfQuota >= 0) {
    base.quotaText = formatUsdFromQuota(selfQuota);
  } else if (Number.isFinite(loginQuota) && loginQuota > 0) {
    base.quotaText = `${formatUsdFromQuota(loginQuota)}（来源：登录响应，仅供参考）`;
  }

  const reward = base.type === 'success' && base.rewardUsd ? `（+${formatUsdAmount(base.rewardUsd)}）` : '';
  const balance = base.quotaText ? `，余额 ${base.quotaText}` : '';
  console.log(`${LOG_PREFIX} ${verdictIcon(base.type)} ${base.label}：${verdictLabel(base.type)}${reward}${balance}`);

  return base;
}

function toFailureResult(account, error, baseUrl) {
  const type = describeFailureType(error);
  const result = {
    label: account.label,
    masked: maskAccount(account.username),
    baseUrl: baseUrl || DEFAULT_BASE_URL,
    type: 'exception',
    detail: '⚠️ 该账号执行失败（详情见面板日志）',
    quotaText: '',
    checkinAt: null,
    rewardUsd: null,
  };

  const message = error && error.message ? error.message : String(error);

  if (type === 'auth_failed' || type === 'banned') {
    // 凭证类：文案由通知层自生成，这里只保留类型
    console.error(`${LOG_PREFIX} ❌ ${account.label}：登录被拒（${type}，${redactLog(message)}）`);
    result.type = type;
    result.detail = '';
    return result;
  }

  console.error(`${LOG_PREFIX} ❌ ${account.label}：${redactLog(message)}`);

  if (type === 'network') {
    result.type = 'network';
    result.detail = message;
  } else if (type === 'login_rejected') {
    result.type = 'login_rejected';
    result.detail = '⚠️ 登录未成功，详情见面板日志';
  }

  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms)); // 被 await 的等待绝不能 unref
}

function randomDelay() {
  const [min, max] = ACCOUNT_DELAY_MS;
  return min + Math.floor(Math.random() * (max - min + 1));
}

// ——— 主流程 ———

async function main() {
  loadDotEnv();

  // 配置错误按类型分流，交给顶层 catch（配置缺失属非凭证类，文案必须无关键词）
  const accounts = parseAccounts(process.env.AGENTROUTER_ACCOUNTS);
  const config = { baseUrl: resolveBaseUrl(), timeoutMs: resolveTimeout() };

  console.log(
    `${LOG_PREFIX} 🚀 ${TASK_TITLE} 开始：共 ${accounts.length} 个账号，站点 ${config.baseUrl}，超时 ${config.timeoutMs}ms`,
  );

  const results = [];
  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index];
    if (index > 0) {
      const wait = randomDelay();
      console.log(`${LOG_PREFIX} ⏳ 等待 ${wait}ms 后处理下一个账号`);
      await sleep(wait);
    }

    try {
      results.push(await runAccount(config, account));
    } catch (error) {
      // 单号异常不影响后续账号
      results.push(toFailureResult(account, error, config.baseUrl));
    }
  }

  const failed = results.filter(result => !isSuccessType(result.type)).length;
  const notification = buildNotification(results);
  console.log(`${LOG_PREFIX} 📊 ${buildHeadline(results)}`);

  await notify(notification.title, notification.body);

  process.exitCode = failed > 0 ? 1 : 0;
}

// ——— 离线自检：全程不发任何网络请求 ———
// 验证方式：本函数入口把 globalThis.fetch 换成必抛桩并计数，末尾断言计数为 0。
// 谁若在自检里塞进会真发包的路径，这条断言立刻转红。

async function runSelfCheck() {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  let gateInstalled = false;
  try {
    globalThis.fetch = () => {
      networkCalls += 1;
      throw new Error('OFFLINE_FETCH_BLOCKED');
    };
    gateInstalled = true;
  } catch {
    gateInstalled = false;
  }

  const cases = [];
  const check = (name, actual, expected) => {
    cases.push([name, actual, expected]);
  };
  const inc = (text, needle) => String(text === null || text === undefined ? '' : text).includes(needle);

  const configMessage = (raw) => {
    try {
      parseAccounts(raw);
      return 'NO_THROW';
    } catch (error) {
      return error instanceof AgentRouterError ? `${error.type}|${error.message}` : `OTHER|${error && error.message}`;
    }
  };

  // 1) 分流关键词：凭证类 / 顶层兜底必须命中，其余必须不命中
  const credentialText = credentialNotice('auth_failed', 'https://example.com');
  check('分流：凭证类文案命中失效 Bot', matchesAlertRouting(credentialText), true);
  check(
    '分流：凭证类文案含「已失效 + 重新登录 + 变量名」',
    [inc(credentialText, '已失效'), inc(credentialText, '重新登录'), inc(credentialText, 'AGENTROUTER_ACCOUNTS')],
    [true, true, true],
  );
  check('分流：封禁文案同样命中', matchesAlertRouting(credentialNotice('banned', 'https://example.com')), true);
  check('分流：顶层兜底模板命中', matchesAlertRouting('❌ 发生异常:执行失败\n\n错误类型: 未知'), true);

  const benignTexts = [
    '✅ 成功 1 / 共 1\n✅ 签到成功（+$25.00）\n   余额：$275.00',
    '⏭️ 今日已签到',
    '⚠️ 登录成功但未查到今日签到记录（详情见面板日志）',
    '⚠️ 网络请求失败：请求超时（20000ms）',
    '⚠️ 网络请求失败：服务端返回 HTTP 502',
    '⚠️ 登录未成功，详情见面板日志',
    '⚠️ 今日签到未确认',
  ];
  check('分流：成功/已签到/无日志/网络类文案都不命中', benignTexts.map(matchesAlertRouting), benignTexts.map(() => false));

  // 2) noticeSafe：外部文本收口
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl';
  const safeJwt = noticeSafe(`{"token":"${jwt}"}`);
  check('收口：JSON 形态 token 不泄漏且不命中', [inc(safeJwt, jwt), matchesAlertRouting(safeJwt)], [false, false]);
  check('收口：invalid escape → 中性占位', noticeSafe('Invalid \\escape: line 1 column 7'), NOTICE_SAFE_PLACEHOLDER);
  check('收口：expired 文案 → 中性占位', noticeSafe('token expired'), NOTICE_SAFE_PLACEHOLDER);
  check('收口：账号名含失效 → 中性占位', noticeSafe('已失效账号'), NOTICE_SAFE_PLACEHOLDER);
  check('收口：正常文本原样返回', noticeSafe('每日签到成功'), '每日签到成功');
  check('收口：占位文案自身不命中分流', matchesAlertRouting(NOTICE_SAFE_PLACEHOLDER), false);

  // 3) redactLog：凭证脱敏（三种形态）
  check('脱敏：password 值不出现', inc(redactLog('password=FAKE_PWD_123'), 'FAKE_PWD_123'), false);
  check(
    '脱敏：session Cookie 值不出现（Cookie 头形态）',
    inc(redactLog('Cookie: session=FAKE_SESSION_ABC; New-Api-User=1'), 'FAKE_SESSION_ABC'),
    false,
  );
  // 单独一条：没有 Cookie 前缀、只剩 session=… —— 锁住 redactLog 里的 session 关键词本身
  // 删掉筛选词表里的 session 后，本条必转红（只测 Cookie 形态时它会因 cookie 关键词而假绿）
  check('脱敏：裸 session=… 也不出现', inc(redactLog('session=FAKE_SESSION_ABC'), 'FAKE_SESSION_ABC'), false);
  check('脱敏：裸 Bearer 令牌不出现', inc(redactLog('Authorization: Bearer FAKE_BEARER_TOKEN_XYZ'), 'FAKE_BEARER_TOKEN_XYZ'), false);
  // 没有 Authorization 前缀的裸 Bearer —— 锁住那条独立的 Bearer 清理规则
  check('脱敏：无 key 名的 Bare Bearer 也不出现', inc(redactLog('Bearer FAKE_BEARER_TOKEN_XYZ'), 'FAKE_BEARER_TOKEN_XYZ'), false);
  check('脱敏：JSON token 值不出现', inc(redactLog('{"token":"FAKE_JSON_TOKEN"}'), 'FAKE_JSON_TOKEN'), false);
  check('脱敏：裸 JWT 不出现', inc(redactLog(jwt), jwt), false);

  // 4) 时区：签到按北京时间自然日
  check('时区：1793581171 → 2026-11-02', toBeijingDayKey(1793581171), '2026-11-02');
  check('时区：1793496320 → 2026-11-01', toBeijingDayKey(1793496320), '2026-11-01');
  const crossUtcSec = Date.UTC(2026, 10, 1, 17, 0, 0) / 1000; // UTC 11-01 17:00 = 北京 11-02 01:00
  check(
    '时区：跨 UTC 日按北京时间归日',
    [toBeijingDayKey(crossUtcSec), new Date(crossUtcSec * 1000).toISOString().slice(0, 10)],
    ['2026-11-02', '2026-11-01'],
  );
  check('时区：通知时间渲染为北京时间', formatBeijingTime(1793581171), '2026-11-02 08:59');

  // 5) 日志核验（四种夹具 + 两条边界）
  const nowMs = Date.UTC(2026, 10, 2, 4, 0, 0); // 北京 2026-11-02 12:00
  const nowSec = Math.floor(nowMs / 1000);
  const runStartMs = nowMs - 2 * 60 * 1000;
  const mkLog = (sec, content = '每日签到成功，增加额度 ＄25.000000 额度', type = 4) => ({ created_at: sec, type, content });
  check('日志核验：今日新签 → fresh', pickTodayCheckin([mkLog(nowSec - 60)], runStartMs, nowMs).level, 'fresh');
  check('日志核验：今日早签 → today', pickTodayCheckin([mkLog(nowSec - 4 * 3600)], runStartMs, nowMs).level, 'today');
  check('日志核验：只有昨日 → none', pickTodayCheckin([mkLog(nowSec - 86400)], runStartMs, nowMs).level, 'none');
  check('日志核验：空数组 → none', pickTodayCheckin([], runStartMs, nowMs).level, 'none');
  check(
    '日志核验：非签到记录不算（type=2 且无关键词）',
    pickTodayCheckin([mkLog(nowSec - 30, '模型调用扣费', 2)], runStartMs, nowMs).level,
    'none',
  );
  check(
    '日志核验：content 含「签到成功」也认（type=0）',
    pickTodayCheckin([mkLog(nowSec - 30, '每日签到成功，增加额度 ＄25.000000 额度', 0)], runStartMs, nowMs).level,
    'fresh',
  );
  check('日志核验：从签到记录解析出 $25', pickTodayCheckin([mkLog(nowSec - 60)], runStartMs, nowMs).rewardUsd, 25);
  check('日志核验：无法解析奖励时回落 null', parseRewardUsd('每日签到成功'), null);

  // 6) verdict 定稿 —— ★ 有牙齿的一条
  check('判定：今日新签 → success', decide({ loginData: { checked_in: false }, logLevel: 'fresh' }), 'success');
  check('判定：今日早签 → already', decide({ loginData: { checked_in: true }, logLevel: 'today' }), 'already');
  // 变异测试：把 decide() 改成「loginData.checked_in 为真就返回 success」→ 本条必须转红
  check(
    '判定：checked_in=true 但今日无日志 → no_log（禁止仅凭 checked_in 报成功）',
    decide({ loginData: { checked_in: true, quota: 137500000 }, selfData: { quota: 137500000 }, logLevel: 'none' }),
    'no_log',
  );
  check('判定：no_log 不计入成功', [isSuccessType('no_log'), isSuccessType('success'), isSuccessType('already')], [false, true, true]);

  // 7) 余额换算
  check('余额：137500000 quota → 275 美元', quotaToUsd(137500000), 275);
  check('余额：87500000 quota → 175 美元', quotaToUsd(87500000), 175);
  check('余额：非数字回落 null', quotaToUsd('abc'), null);

  // 8) 配置解析（四种输入）
  const msgMissing = configMessage('');
  const msgNotArray = configMessage('{"username":"u1@example.com"}');
  const msgBadJson = configMessage('[{"name":"x"');
  const msgMissingField = configMessage('[{"username":"u1@example.com"}]');
  check(
    '配置：缺失 → 指向变量名且不命中分流',
    [inc(msgMissing, 'config_missing'), inc(msgMissing, 'AGENTROUTER_ACCOUNTS'), matchesAlertRouting(msgMissing)],
    [true, true, false],
  );
  check(
    '配置：非数组 → 提示必须是 JSON 数组且不命中分流',
    [inc(msgNotArray, '必须是 JSON 数组'), matchesAlertRouting(msgNotArray)],
    [true, false],
  );
  check(
    '配置：非法 JSON → 带解析错误且不命中分流',
    [inc(msgBadJson, '不是合法的 JSON'), matchesAlertRouting(msgBadJson)],
    [true, false],
  );
  // 这条输入会让 Node 把原文片段回显进 JSON.parse 的错误消息里 → 必须被截掉，不能带进通知
  const msgEchoing = configMessage('[{"username":"a@b.c","password":"FAKE_SECRET_9"},]');
  check(
    '配置：解析错误不回显输入里的账号/密码',
    [inc(msgEchoing, 'FAKE_SECRET_9'), inc(msgEchoing, 'a@b.c'), inc(msgEchoing, '不是合法的 JSON')],
    [false, false, true],
  );
  check(
    '配置：缺字段 → 报出下标与字段名且不命中分流',
    [
      inc(msgMissingField, 'AGENTROUTER_ACCOUNTS[0]'),
      inc(msgMissingField, 'password'),
      matchesAlertRouting(msgMissingField),
    ],
    [true, true, false],
  );
  check(
    '配置：通知正文不命中分流（缺失 / 非法 JSON）',
    [matchesAlertRouting(buildConfigMissingText(msgMissing.split('|')[1])), matchesAlertRouting(buildConfigMissingText(msgBadJson.split('|')[1]))],
    [false, false],
  );
  const parsedOk = parseAccounts('[{"username":"u1@example.com","password":"p1"},{"name":"二号","username":"u2","password":"p2"}]');
  check('配置：合法数组解析出两个账号、默认名带序号', [parsedOk.length, parsedOk[0].label, parsedOk[1].label], [2, '账号1', '二号']);
  const parsedPoisoned = parseAccounts('[{"name":"已失效账号","username":"u3@example.com","password":"p3"}]');
  check(
    '配置：账号名命中分流关键词 → 回落「账号N」且不命中',
    [parsedPoisoned[0].label, matchesAlertRouting(parsedPoisoned[0].label)],
    ['账号1', false],
  );

  // 可选变量：非法值回落默认，不中断任务
  const previousTimeout = process.env.AGENTROUTER_TIMEOUT_MS;
  const probeTimeout = (raw) => {
    process.env.AGENTROUTER_TIMEOUT_MS = raw;
    try {
      return resolveTimeout();
    } finally {
      if (previousTimeout === undefined) delete process.env.AGENTROUTER_TIMEOUT_MS;
      else process.env.AGENTROUTER_TIMEOUT_MS = previousTimeout;
    }
  };
  check(
    '配置：超时非法/越界回落默认值，合法值生效',
    [probeTimeout('abc'), probeTimeout('999999'), probeTimeout('15000'), probeTimeout('')],
    [DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 15000, DEFAULT_TIMEOUT_MS],
  );

  // 9) 脱敏显示
  check('脱敏显示：邮箱只留前 2 字符', maskAccount('1234567890@example.com'), '12***@example.com');
  check('脱敏显示：用户名只留前 4 字符', maskAccount('abcdefgh'), 'abcd***');
  check('脱敏显示：空值回落', maskAccount(''), '未知账号');

  // 10) 通知组装：不泄漏、计数与明细一致、回落真正生效
  const okResult = {
    label: '账号1',
    masked: 'u1***@example.com',
    baseUrl: 'https://example.com',
    type: 'success',
    checkinAt: 1793581171,
    rewardUsd: 25,
    quotaText: formatUsdFromQuota(137500000),
  };
  const okNotice = buildNotification([okResult]);
  check(
    '通知：成功通知不含密码 / 完整邮箱 / 不命中分流',
    [inc(okNotice.body, 'p1'), inc(okNotice.body, 'u1@example.com'), matchesAlertRouting(`${okNotice.title}\n${okNotice.body}`)],
    [false, false, false],
  );
  const mixedResults = [
    okResult,
    {
      label: '账号2',
      masked: 'u2***@example.com',
      baseUrl: 'https://example.com',
      type: 'no_log',
      detail: '⚠️ 登录成功但未查到今日签到记录（详情见面板日志）',
    },
  ];
  const mixedNotice = buildNotification(mixedResults);
  check(
    '通知：成功 N / 共 M 与明细一致且不命中分流',
    [inc(mixedNotice.body, '成功 1 / 共 2'), matchesAlertRouting(`${mixedNotice.title}\n${mixedNotice.body}`)],
    [true, false],
  );
  const poisonedDetail = {
    label: '账号1',
    masked: 'u1***@example.com',
    baseUrl: 'https://example.com',
    type: 'network',
    detail: '⚠️ 已失效',
  };
  const tier1 = buildNotification([poisonedDetail]);
  check(
    '回落①：明细含关键词且无凭证失败 → 剔明细重建',
    [tier1.tier, matchesAlertRouting(`${tier1.title}\n${tier1.body}`), inc(tier1.body, '已失效')],
    [1, false, false],
  );
  const tier2 = buildNotification([{ ...poisonedDetail, label: '已失效账号' }]);
  check(
    '回落②：账号名也含关键词 → 降级最小化通知',
    [tier2.tier, matchesAlertRouting(`${tier2.title}\n${tier2.body}`), inc(tier2.body, '已失效')],
    [2, false, false],
  );
  const credentialResults = [
    { label: '账号1', masked: 'u1***@example.com', baseUrl: 'https://example.com', type: 'auth_failed', detail: '' },
  ];
  const credentialNoticeBuilt = buildNotification(credentialResults);
  check(
    '回落：存在凭证类失败时原样发送并命中失效 Bot',
    [
      credentialNoticeBuilt.tier,
      matchesAlertRouting(`${credentialNoticeBuilt.title}\n${credentialNoticeBuilt.body}`),
      inc(credentialNoticeBuilt.body, 'AGENTROUTER_ACCOUNTS'),
    ],
    [0, true, true],
  );

  // 11) 端到端式自检：用桩 fetch 驱动**真实** runAccount，锁住「checked_in=true 但今日无日志 → no_log」。
  //     ★ 这一组是有牙齿的那条：把 decide() 改成「checked_in 为真就 success」、或把日志核验整段关掉，
  //       下面两条断言必转红。（变异验证方式见 design.md §9 第 6 条。）
  const jsonResponse = (body, headers = {}) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
  const withFetchStub = async (handler, fn) => {
    const saved = globalThis.fetch;
    globalThis.fetch = handler;
    try {
      return await fn();
    } finally {
      globalThis.fetch = saved;
    }
  };
  const fakeRunStart = Date.now();
  const makeFetchStub = (logItems) => (url) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === '/api/user/login') {
      return Promise.resolve(jsonResponse(
        { success: true, message: '', data: { id: 4242, checked_in: true, quota: 0 } },
        { 'set-cookie': 'session=FAKE_SELFCHECK_SESSION; Path=/; HttpOnly' },
      ));
    }
    if (pathname === '/api/user/self') {
      return Promise.resolve(jsonResponse({ success: true, message: '', data: { id: 4242, quota: 137500000 } }));
    }
    if (pathname === '/api/log/self') {
      return Promise.resolve(jsonResponse({ success: true, message: '', data: { items: logItems } }));
    }
    return Promise.reject(new Error(`UNEXPECTED_STUB_URL ${pathname}`));
  };
  const fakeAccount = { username: 'selfcheck@example.com', password: 'FAKE_SELFCHECK_PWD', label: '自检账号', index: 0 };
  const fakeConfig = { baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000 };

  const noLogRun = await withFetchStub(
    makeFetchStub([{ created_at: Math.floor(fakeRunStart / 1000) - 24 * 3600, type: 4, content: '每日签到成功，增加额度 ＄25.000000 额度' }]),
    () => runAccount(fakeConfig, fakeAccount),
  );
  check('端到端：真实流程下 checked_in=true + 今日无日志 → no_log', noLogRun.type, 'no_log');
  check('端到端：no_log 仍能报出余额', noLogRun.quotaText, '$275.00');

  const freshRun = await withFetchStub(
    makeFetchStub([{ created_at: Math.floor(fakeRunStart / 1000) - 5, type: 4, content: '每日签到成功，增加额度 ＄25.000000 额度' }]),
    () => runAccount(fakeConfig, fakeAccount),
  );
  check('端到端：今日新签日志 → success 且解析出奖励', [freshRun.type, freshRun.rewardUsd], ['success', 25]);

  // 路由不存在（例如 AGENTROUTER_BASE_URL 填错域名）时服务端回 404 + {"message":"Invalid URL"}：
  // 必须归网络类，不能被 invalid 拽进凭证失效分流。变异测试：把 requestJson 的 status>=400 改回 >=500，本条转红。
  const notFoundType = await withFetchStub(
    () => Promise.resolve(new Response(JSON.stringify({ success: false, message: 'Invalid URL' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })),
    async () => {
      try {
        await runAccount(fakeConfig, fakeAccount);
        return 'NO_THROW';
      } catch (error) {
        return error instanceof AgentRouterError ? error.type : 'OTHER';
      }
    },
  );
  check('端到端：登录路由 404（Invalid URL）→ network 而非凭证失效', notFoundType, 'network');

  // 12) 离线闸门：本自检全程不得发起任何网络请求
  check('离线自检：全程零网络请求（fetch 桩已安装且计数为 0）', [networkCalls, gateInstalled], [0, true]);

  if (typeof originalFetch === 'function') globalThis.fetch = originalFetch;
  else delete globalThis.fetch;

  let failed = 0;
  for (const [name, actual, expected] of cases) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    if (pass) {
      console.log(`PASS  ${name}`);
    } else {
      failed += 1;
      console.error(`FAIL  ${name}: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
    }
  }

  const total = cases.length;
  console.log(`${LOG_PREFIX} 自检${failed ? ` 未通过(${failed}/${total})` : ` 全部通过(${total}/${total})`}`);
  process.exitCode = failed ? 1 : 0;
}

if (require.main === module) {
  if (process.argv.includes('--selfcheck')) {
    // 短路在 main() 之前，绝不发网络请求
    runSelfCheck().catch((error) => {
      console.error(`${LOG_PREFIX} ❌ 自检自身异常：${redactLog(error && error.message)}`);
      process.exitCode = 1;
    });
  } else {
    main().catch(async (error) => {
      const isConfigMissing = error instanceof AgentRouterError && error.type === 'config_missing';
      const rawMessage = error && error.message ? error.message : String(error);

      if (isConfigMissing) {
        // 配置缺失属非凭证类：不走「发生异常」兜底模板（那会命中失效分流）。
        // 这条文案是自生成的，外部错误（JSON.parse 原文）在 parseAccounts 内已单独收口，
        // 这里不再做 redactLog —— 否则示例里的 "password":"…" 会被整段替换成 [redacted]。
        console.error(`${LOG_PREFIX} ❌ ${TASK_TITLE} 未配置必需变量`);
        await notify(TASK_TITLE, buildConfigMissingText(rawMessage));
      } else {
        const errText = noticeSafe(rawMessage);
        console.error(`${LOG_PREFIX} ❌ ${TASK_TITLE} 执行失败：${errText}`);
        await notify(TASK_TITLE, `❌ 发生异常:执行失败\n\n${errText}`);
      }

      process.exitCode = 1;
    });
  }
}

module.exports = {
  AgentRouterError,
  redactLog,
  matchesAlertRouting,
  noticeSafe,
  maskAccount,
  parseAccounts,
  resolveBaseUrl,
  resolveTimeout,
  toBeijingDayKey,
  formatBeijingTime,
  quotaToUsd,
  parseRewardUsd,
  pickTodayCheckin,
  decide,
  isSuccessType,
  buildNotification,
  buildConfigMissingText,
  credentialNotice,
  classifyLoginFailure,
  describeJsonParseError,
};
