#!/usr/bin/env node
'use strict';
/**
 * cron: 25 8 * * *
 * new Env('RunAnytime 签到');
 *
 * 必填环境变量:
 *   RUNANYTIME_ACCOUNTS="完整 Cookie 字符串（须包含 refresh 凭证 cookie，可含 cf_clearance）"
 *
 * 可选环境变量:
 *   RUNANYTIME_USER_AGENT="获取 Cookie 时浏览器的 User-Agent"（cf_clearance 与 UA 绑定，建议一并配置）
 *   RUNANYTIME_POW_TIMEOUT_MS=60000
 *   RUNANYTIME_TRACE=false
 *
 * 说明:
 *   站点（New API 分支）已从 gorilla session 迁移到 JWT Bearer 认证：
 *     1. POST /api/user/auth/refresh  凭 HttpOnly refresh cookie 换取 access token（15 分钟有效）
 *     2. GET  /api/user/checkin?month=YYYY-MM  查询今日是否已签到
 *     3. GET  /api/user/pow/challenge?action=checkin  取 {challenge_id, prefix, difficulty}
 *     4. 本地计算 SHA-256(prefix + nonce) 满足 difficulty 个前导零 bit 的 nonce
 *     5. POST /api/user/checkin?pow_challenge=..&pow_nonce=..  （Bearer 认证）
 *   PoW 模式为 replace，纯 HTTP 即可完成，无需浏览器。
 *   refresh cookie（new_api_refresh，HttpOnly）每次刷新都会轮换，脚本会自动
 *   合并新值；青龙环境下通过 QLAPI 写回环境变量，本地运行则打印新值提醒。
 */

const { createHash } = require('node:crypto');

const TASK_TITLE = 'RunAnytime 签到';
const SITE_URL = 'https://runanytime.hxi.me';
const COOKIE_ENV = 'RUNANYTIME_ACCOUNTS';
const DEFAULT_POW_TIMEOUT_MS = 60000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

class RunAnytimeError extends Error {
  constructor(type, message) {
    super(message);
    this.name = 'RunAnytimeError';
    this.type = type;
  }
}

function normalizeCookie(cookie) {
  return String(cookie || '')
    .trim()
    .replace(/^cookie\s*:\s*/i, '')
    .replace(/[\r\n]+/g, '')
    .replace(/;\s*/g, '; ');
}

function parseBoolean(value, fallback) {
  if (value == null || String(value).trim() === '') return fallback;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  throw new RunAnytimeError('config_error', `无效布尔值: ${value}`);
}

function parsePositiveInteger(value, fallback) {
  const number = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function formatShanghaiMonth(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}`;
}

function formatReward(rawQuota) {
  const quota = Number(rawQuota);
  if (!Number.isFinite(quota) || quota <= 0) return '';
  return quota.toLocaleString('en-US');
}

function getNotify() {
  try {
    const mod = require('./sendNotify');
    return typeof mod === 'function' ? mod : mod?.sendNotify || mod?.default || null;
  } catch {
    return null;
  }
}

async function sendResult(title, content) {
  const notify = getNotify();
  if (typeof notify === 'function') {
    try {
      await notify(title, content);
      return;
    } catch {}
  }
  console.log(`\n${title}\n${content}`);
}

function formatResult(result) {
  const lines = [];
  if (result.type === 'success') {
    lines.push(result.reward ? `✅ 签到成功，获得 ${result.reward} 额度` : '✅ 签到成功');
  } else if (result.type === 'already_checked') {
    lines.push('⏭️ 今日已签到');
  } else {
    lines.push(`❌ 发生异常：${result.message}`);
  }
  if (result.cookieRotated) {
    if (result.cookiePersisted) {
      lines.push('🔄 登录凭证已轮换，已自动写回环境变量');
    } else {
      lines.push(`⚠️ 登录凭证已轮换但未能自动保存，请用日志中的新 Cookie 更新 ${COOKIE_ENV}，否则下次运行将掉登录`);
    }
  }
  return lines.join('\n');
}

/** 替换或追加 Cookie 串中的某一项 */
function mergeCookie(cookie, name, value) {
  const items = cookie.split(';').map(item => item.trim()).filter(Boolean);
  const index = items.findIndex(item => item.slice(0, item.indexOf('=')).trim() === name);
  if (index >= 0) items[index] = `${name}=${value}`;
  else items.push(`${name}=${value}`);
  return items.join('; ');
}

/** 青龙环境下通过 QLAPI 将轮换后的 Cookie 写回环境变量 */
async function persistCookie(newCookie) {
  if (typeof QLAPI === 'undefined' || typeof QLAPI.getEnvs !== 'function') return false;
  try {
    const envs = await QLAPI.getEnvs({ searchValue: COOKIE_ENV });
    const item = (envs?.data || []).find(env => env.name === COOKIE_ENV);
    if (!item) return false;
    await QLAPI.updateEnv({ env: { ...item, value: newCookie } });
    return true;
  } catch (error) {
    console.warn(`[RunAnytime] 写回环境变量失败: ${error?.message || error}`);
    return false;
  }
}

function hasLeadingZeroBits(bytes, bits) {
  if (bits <= 0) return true;
  const fullBytes = Math.floor(bits / 8);
  const remainder = bits % 8;
  for (let i = 0; i < fullBytes; i++) {
    if (bytes[i] !== 0) return false;
  }
  return remainder === 0 || (bytes[fullBytes] & (255 << (8 - remainder))) === 0;
}

/** 复刻站点 worker：求满足 difficulty 个前导零 bit 的 8 位十六进制 nonce */
function solvePow(prefix, difficulty, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (let counter = 0; counter <= 0xffffffff; counter++) {
    const nonce = counter.toString(16).padStart(8, '0');
    const digest = createHash('sha256').update(prefix + nonce).digest();
    if (hasLeadingZeroBits(digest, difficulty)) return nonce;
    if ((counter & 0x3fff) === 0 && Date.now() > deadline) {
      throw new RunAnytimeError('error', `PoW 求解超时（difficulty=${difficulty}）`);
    }
  }
  throw new RunAnytimeError('error', 'PoW 求解耗尽计数仍无解');
}

class RunAnytimeClient {
  constructor(config) {
    this.cookie = config.cookie;
    this.userAgent = config.userAgent;
    this.trace = config.trace;
    this.accessToken = '';
    this.sessionId = '';
    this.cookieRotated = false;
  }

  async request(method, apiPath, { auth = true } = {}) {
    const headers = {
      Accept: 'application/json',
      Cookie: this.cookie,
      Referer: `${SITE_URL}/console/personal`,
      'User-Agent': this.userAgent,
    };
    if (auth && this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
    if (!auth && this.sessionId) headers['X-Auth-Session'] = this.sessionId;

    let response;
    try {
      response = await fetch(`${SITE_URL}${apiPath}`, { method, headers });
    } catch (error) {
      throw new RunAnytimeError('network_error', `请求 ${apiPath} 失败: ${error?.message || error}`);
    }
    const payload = await response.json().catch(() => null);
    if (this.trace) {
      console.log(`[RunAnytime] ${method} ${apiPath.replace(/\?.*$/, '')} -> HTTP ${response.status}`);
    }
    if (payload == null) {
      const hint = response.status === 403 ? '（疑似 Cloudflare 拦截，请更新 cf_clearance）' : '';
      throw new RunAnytimeError('network_error', `${apiPath} 返回非 JSON，HTTP ${response.status}${hint}`);
    }
    return { status: response.status, payload, headers: response.headers };
  }

  /** 凭 refresh cookie 换取短期 access token；429 限流退避重试，凭证轮换时记录提醒 */
  async refresh(maxAttempts = 4) {
    let status;
    let payload;
    let headers;
    for (let attempt = 1; ; attempt++) {
      let limited = false;
      try {
        ({ status, payload, headers } = await this.request('POST', '/api/user/auth/refresh', { auth: false }));
        if (status !== 429) break;
        limited = true;
      } catch (error) {
        if (!(error instanceof RunAnytimeError) || !/HTTP 429/.test(error.message)) throw error;
        limited = true;
      }
      if (limited) {
        if (attempt >= maxAttempts) {
          throw new RunAnytimeError('network_error', '刷新 access token 持续被限流（HTTP 429），请稍后重试');
        }
        const waitMs = 15000 * attempt;
        console.log(`[RunAnytime] 刷新接口限流，${waitMs / 1000}s 后重试（${attempt}/${maxAttempts - 1}）`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
    }
    if (!payload.success || !payload.data) {
      if ([401, 403, 409].includes(status)) {
        throw new RunAnytimeError(
          'auth_failed',
          `登录凭证已失效（HTTP ${status} ${payload.message || payload.code || ''}），请重新登录并更新 ${COOKIE_ENV}`
        );
      }
      throw new RunAnytimeError('network_error', `刷新 access token 失败：HTTP ${status} ${payload.message || ''}`);
    }

    const data = payload.data;
    this.accessToken = data.access_token || data.accessToken || data.token || '';
    this.sessionId = data.session?.sid || data.sid || '';
    if (!this.accessToken) {
      throw new RunAnytimeError('schema_changed', '刷新接口未返回 access token，站点接口可能已变更');
    }

    const setCookie = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers.get('set-cookie')].filter(Boolean);
    for (const item of setCookie) {
      const [pair] = item.split(';');
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      if (/^cf_/i.test(name)) continue;
      this.cookieRotated = true;
      this.cookie = mergeCookie(this.cookie, name, pair.slice(separator + 1).trim());
      console.log(`[RunAnytime] 🔄 站点轮换了凭证 Cookie: ${name}`);
    }
  }
}

async function runCheckin(config) {
  const client = new RunAnytimeClient(config);
  const withRotation = result => ({
    ...result,
    cookieRotated: client.cookieRotated,
    updatedCookie: client.cookieRotated ? client.cookie : '',
  });

  try {
    await client.refresh();

    // 确认今日签到状态
    const month = formatShanghaiMonth();
    const status = await client.request('GET', `/api/user/checkin?month=${encodeURIComponent(month)}`);
    if (!status.payload.success) {
      if ([401, 403].includes(status.status)) {
        throw new RunAnytimeError('auth_failed', 'access token 未被接受，请更新 Cookie 后重试');
      }
      throw new RunAnytimeError('network_error', `查询签到状态失败：HTTP ${status.status} ${status.payload.message || ''}`);
    }
    if (status.payload.data?.enabled === false) {
      return withRotation({ type: 'error', message: '站点已关闭签到功能' });
    }
    if (status.payload.data?.stats?.checked_in_today === true) {
      return withRotation({ type: 'already_checked', message: '今日已签到' });
    }

    // 获取并求解 PoW challenge
    const challenge = await client.request('GET', '/api/user/pow/challenge?action=checkin');
    if (!challenge.payload.success || !challenge.payload.data) {
      throw new RunAnytimeError(
        'network_error',
        `获取 PoW challenge 失败：HTTP ${challenge.status} ${challenge.payload.message || ''}`
      );
    }
    const { challenge_id: challengeId, prefix, difficulty } = challenge.payload.data;
    if (!challengeId || !prefix || typeof difficulty !== 'number') {
      throw new RunAnytimeError('schema_changed', 'PoW challenge 参数异常，站点接口可能已变更');
    }
    const nonce = solvePow(prefix, difficulty, config.powTimeoutMs);
    if (config.trace) console.log(`[RunAnytime] PoW 求解完成 difficulty=${difficulty}`);

    // 提交签到
    const params = new URLSearchParams({ pow_challenge: challengeId, pow_nonce: nonce });
    const submit = await client.request('POST', `/api/user/checkin?${params.toString()}`);
    if (submit.payload.success) {
      return withRotation({
        type: 'success',
        message: '签到成功',
        reward: formatReward(submit.payload.data?.quota_awarded),
      });
    }

    const message = submit.payload.message || `HTTP ${submit.status}`;
    if ([401, 403].includes(submit.status)) {
      return withRotation({ type: 'auth_failed', message: `签到提交被拒：${message}` });
    }
    if (/已签到|already/i.test(message)) {
      return withRotation({ type: 'already_checked', message: '今日已签到' });
    }
    if (/turnstile|人机验证/i.test(message)) {
      return withRotation({
        type: 'challenge_required',
        message: `站点要求 Turnstile：${message}，签到机制已变更，请人工确认`,
      });
    }
    return withRotation({ type: 'error', message: `签到失败：${message}` });
  } catch (error) {
    if (error instanceof RunAnytimeError) {
      return withRotation({ type: error.type, message: error.message });
    }
    return withRotation({ type: 'error', message: `执行失败: ${error?.message || String(error)}` });
  }
}

function printHelp() {
  console.log(`${TASK_TITLE}

用法:
  node gongyizhan/runanytime-browser.js

必填环境变量:
  ${COOKIE_ENV}              完整 Cookie 字符串（须包含 refresh 凭证 cookie）

可选环境变量:
  RUNANYTIME_USER_AGENT      获取 Cookie 时浏览器的完整 User-Agent
  RUNANYTIME_POW_TIMEOUT_MS  PoW 求解超时毫秒数，默认 ${DEFAULT_POW_TIMEOUT_MS}
  RUNANYTIME_TRACE           true/false，输出请求路径与响应状态，默认 false

说明:
  站点已迁移到 JWT Bearer 认证：脚本先用 refresh cookie 换取 15 分钟有效的
  access token，再完成 PoW 求解与签到提交，纯 HTTP 无需浏览器。
  refresh cookie 为 HttpOnly，需从浏览器 DevTools -> Application -> Cookies
  复制站点全部 Cookie 填入 ${COOKIE_ENV}。`);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const rawCookie = process.env[COOKIE_ENV];
  if (!rawCookie?.trim()) {
    await sendResult(TASK_TITLE, `❌ 发生异常：未配置环境变量 ${COOKIE_ENV}`);
    process.exitCode = 1;
    return;
  }

  let config;
  try {
    config = {
      cookie: normalizeCookie(rawCookie),
      userAgent: process.env.RUNANYTIME_USER_AGENT?.trim() || DEFAULT_USER_AGENT,
      trace: parseBoolean(process.env.RUNANYTIME_TRACE, false),
      powTimeoutMs: parsePositiveInteger(process.env.RUNANYTIME_POW_TIMEOUT_MS, DEFAULT_POW_TIMEOUT_MS),
    };
  } catch (error) {
    await sendResult(TASK_TITLE, `❌ 发生异常：${error.message}`);
    process.exitCode = 1;
    return;
  }

  const result = await runCheckin(config);
  if (result.cookieRotated && result.updatedCookie) {
    result.cookiePersisted = await persistCookie(result.updatedCookie);
    if (!result.cookiePersisted) {
      console.log(`[RunAnytime] 请手动更新 ${COOKIE_ENV} 为：\n${result.updatedCookie}`);
    }
  }
  await sendResult(TASK_TITLE, formatResult(result));
  if (!['success', 'already_checked'].includes(result.type)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(async (error) => {
    await sendResult(TASK_TITLE, `❌ 发生异常：执行异常: ${error.message || String(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  RunAnytimeClient,
  RunAnytimeError,
  formatResult,
  formatReward,
  formatShanghaiMonth,
  hasLeadingZeroBits,
  mergeCookie,
  normalizeCookie,
  parseBoolean,
  parsePositiveInteger,
  runCheckin,
  solvePow,
};
