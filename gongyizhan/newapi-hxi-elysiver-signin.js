#!/usr/bin/env node
// cron: 0 20 8 * * *
// new Env('NewAPI公益站签到');
// description: runanytime.hxi.me 与 elysiver.h-e.top 每日签到，优先使用青龙通知模块发送结果

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 30000;
const QUOTA_UNIT = 500000;
const TASK_NAME = 'NewAPI公益站签到';
const DEFAULT_USER_AGENT = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  'AppleWebKit/537.36 (KHTML, like Gecko)',
  'Chrome/125.0.0.0 Safari/537.36',
].join(' ');

const SITE_DEFINITIONS = [
  {
    id: 'runanytime',
    label: '随时跑路公益站',
    envPrefix: 'RUNANYTIME',
    defaultBaseUrl: 'https://runanytime.hxi.me',
  },
  {
    id: 'elysiver',
    label: '烁',
    envPrefix: 'ELYSIVER',
    defaultBaseUrl: 'https://elysiver.h-e.top',
  },
];

class SignInError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SignInError';
    this.details = details;
  }
}

function loadDotEnv() {
  const candidates = [
    path.join(process.cwd(), '.env'),
    path.join(__dirname, '..', '.env'),
  ];

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;

    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const equalsIndex = trimmed.indexOf('=');
      if (equalsIndex === -1) continue;

      const key = trimmed.slice(0, equalsIndex).trim();
      let value = trimmed.slice(equalsIndex + 1).trim();
      if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    }
  }
}

function parseArgs(argv) {
  const args = {
    help: false,
    statusOnly: false,
    sites: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--status-only') {
      args.statusOnly = true;
    } else if (arg === '--site') {
      const value = argv[index + 1];
      if (!value) throw new SignInError('--site requires a value');
      args.sites.push(value);
      index += 1;
    } else if (arg.startsWith('--site=')) {
      args.sites.push(arg.slice('--site='.length));
    } else {
      throw new SignInError(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printUsage() {
  console.log(`Usage: node gongyizhan/newapi-hxi-elysiver-signin.js [options]

Options:
  --site <id>      Run one site only. Supported: runanytime, elysiver. Can repeat.
  --status-only   Validate auth and print current quota without sending check-in.
  -h, --help      Show this help.

Environment for each site:
  <PREFIX>_API_USER             Required NewAPI user id from localStorage user.id.
  <PREFIX>_SYSTEM_ACCESS_TOKEN  Optional system access token from account security settings.
  <PREFIX>_COOKIE               Optional full Cookie header copied from browser.
  <PREFIX>_SESSION              Optional session cookie value when <PREFIX>_COOKIE is not set.
  <PREFIX>_TURNSTILE_TOKEN      Optional fresh Cloudflare Turnstile token for protected check-in.
  <PREFIX>_USER_AGENT           Optional browser User-Agent matching copied Cloudflare cookies.
  <PREFIX>_IP_FAMILY            Optional, set to 4 to force IPv4 for unstable TLS handshakes.
  <PREFIX>_BASE_URL             Optional site base URL override.
  <PREFIX>_API_USER_HEADER      Optional, defaults to new-api-user.
  <PREFIX>_CHECKIN_PATH         Optional, defaults to /api/user/checkin.
  <PREFIX>_USER_INFO_PATH       Optional, defaults to /api/user/self.

Prefixes:
  RUNANYTIME for https://runanytime.hxi.me
  ELYSIVER   for https://elysiver.h-e.top

At least one of <PREFIX>_SYSTEM_ACCESS_TOKEN, <PREFIX>_COOKIE, or <PREFIX>_SESSION is required.`);
}

function getConfig(args) {
  loadDotEnv();

  const selectedIds = new Set(args.sites.map((value) => value.trim().toLowerCase()).filter(Boolean));
  const unknownIds = [...selectedIds].filter((id) => !SITE_DEFINITIONS.some((site) => site.id === id));
  if (unknownIds.length > 0) {
    throw new SignInError(`Unknown site id: ${unknownIds.join(', ')}`);
  }

  const sites = SITE_DEFINITIONS
    .filter((site) => selectedIds.size === 0 || selectedIds.has(site.id))
    .map((site) => buildSiteConfig(site));

  return { sites };
}

function buildSiteConfig(site) {
  const prefix = site.envPrefix;
  const baseUrl = normalizeBaseUrl(envValue(`${prefix}_BASE_URL`) || site.defaultBaseUrl, `${prefix}_BASE_URL`);
  const apiUser = envValue(`${prefix}_API_USER`);
  const systemAccessToken = envValue(`${prefix}_SYSTEM_ACCESS_TOKEN`);
  const cookie = buildCookieHeader(prefix);
  const timeoutMs = parsePositiveInteger(
    envValue(`${prefix}_TIMEOUT_MS`) || envValue('NEWAPI_TIMEOUT_MS'),
    DEFAULT_TIMEOUT_MS
  );
  const apiUserHeader = envValue(`${prefix}_API_USER_HEADER`) || 'new-api-user';
  const checkInPath = envValue(`${prefix}_CHECKIN_PATH`) || '/api/user/checkin';
  const userInfoPath = envValue(`${prefix}_USER_INFO_PATH`) || '/api/user/self';
  const userAgent = envValue(`${prefix}_USER_AGENT`) || envValue('NEWAPI_USER_AGENT') || DEFAULT_USER_AGENT;
  const turnstileToken = envValue(`${prefix}_TURNSTILE_TOKEN`);
  const ipFamily = parseIpFamily(envValue(`${prefix}_IP_FAMILY`) || envValue('NEWAPI_IP_FAMILY'));
  const retryCount = parseNonNegativeInteger(
    envValue(`${prefix}_RETRY_COUNT`) || envValue('NEWAPI_RETRY_COUNT'),
    2
  );
  const preflightUserInfo = parseBoolean(
    envValue(`${prefix}_PREFLIGHT_USER_INFO`) || envValue('NEWAPI_PREFLIGHT_USER_INFO'),
    false
  );

  if (!apiUser) {
    throw new SignInError(`Missing ${prefix}_API_USER. Read localStorage user.id from ${baseUrl}/console/personal.`);
  }

  if (!systemAccessToken && !cookie) {
    throw new SignInError(
      `Missing credentials for ${site.id}. Set ${prefix}_SYSTEM_ACCESS_TOKEN, ${prefix}_COOKIE, or ${prefix}_SESSION.`
    );
  }

  return {
    ...site,
    baseUrl,
    apiUser,
    systemAccessToken,
    cookie,
    timeoutMs,
    apiUserHeader,
    checkInPath,
    userInfoPath,
    userAgent,
    turnstileToken,
    ipFamily,
    retryCount,
    preflightUserInfo,
  };
}

function envValue(name) {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function buildCookieHeader(prefix) {
  const fullCookie = envValue(`${prefix}_COOKIE`);
  const session = envValue(`${prefix}_SESSION`);
  const bypassCookie = envValue(`${prefix}_BYPASS_COOKIE`);
  const parts = [];

  if (fullCookie) parts.push(fullCookie);
  if (!fullCookie && session) parts.push(`session=${session}`);
  if (bypassCookie) parts.push(bypassCookie);

  return normalizeCookieHeader(parts.join('; '));
}

function normalizeCookieHeader(raw) {
  return raw
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('; ');
}

function normalizeBaseUrl(raw, envName) {
  try {
    const url = new URL(raw);
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch (error) {
    throw new SignInError(`Invalid ${envName}: ${raw}`);
  }
}

function parsePositiveInteger(raw, fallback) {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseNonNegativeInteger(raw, fallback) {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseIpFamily(raw) {
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return value === 4 || value === 6 ? value : undefined;
}

function parseBoolean(raw, fallback) {
  if (!raw) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function isQinglongEnvironment() {
  return Boolean(process.env.QL_DIR || process.env.QL_DATA_DIR || process.env.QL_BRANCH);
}

function getQinglongNotifyModule() {
  const candidates = [
    path.join(process.cwd(), 'sendNotify.js'),
    path.join(process.cwd(), 'notify.js'),
    path.join(process.cwd(), 'function', 'sendNotify.js'),
    path.join(process.cwd(), 'function', 'notify.js'),
    path.join('/ql', 'data', 'scripts', 'sendNotify.js'),
    path.join('/ql', 'data', 'scripts', 'notify.js'),
    path.join('/ql', 'scripts', 'sendNotify.js'),
    path.join('/ql', 'scripts', 'notify.js'),
  ];

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;

    try {
      const mod = require(file);
      const sendNotify = typeof mod.sendNotify === 'function'
        ? mod.sendNotify
        : typeof mod === 'function'
          ? mod
          : null;

      if (sendNotify) {
        return { sendNotify, file };
      }
    } catch (error) {
      console.error(`[newapi] Failed to load Qinglong notify module: ${file}`);
      console.error(`[newapi] Notify load error: ${error.message}`);
    }
  }

  return null;
}

async function sendQinglongNotification(title, body) {
  if (!isQinglongEnvironment()) return false;

  const notify = getQinglongNotifyModule();
  if (!notify) return false;

  try {
    await Promise.resolve(notify.sendNotify(title, body));
    return true;
  } catch (error) {
    console.error(`[newapi] Qinglong notification failed: ${error.message}`);
    return false;
  }
}

async function requestJson(site, method, apiPath, options = {}) {
  let lastError = null;
  const attempts = site.retryCount + 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestJsonOnce(site, method, apiPath, options);
    } catch (error) {
      lastError = error;
      if (!isRetryableNetworkError(error) || attempt === attempts) {
        throw error;
      }

      console.error(`[newapi:${site.id}] Network error on ${method} ${apiPath}: ${error.message}; retry ${attempt}/${site.retryCount}`);
      await delay(800 * attempt);
    }
  }

  throw lastError;
}

function requestJsonOnce(site, method, apiPath, options = {}) {
  const url = new URL(apiPath, site.baseUrl);
  const origin = new URL(site.baseUrl).origin;
  const client = url.protocol === 'http:' ? http : https;
  const body = options.body === undefined ? '' : options.body;
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    Origin: origin,
    Referer: `${origin}/console/personal`,
    'User-Agent': site.userAgent,
    'X-Requested-With': 'XMLHttpRequest',
    [site.apiUserHeader]: `${site.apiUser}`,
    ...options.headers,
  };

  if (site.cookie) {
    headers.Cookie = site.cookie;
  }

  if (site.systemAccessToken) {
    headers.Authorization = `Bearer ${site.systemAccessToken}`;
  }

  if (method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = options.contentType || 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body);
  }

  const requestOptions = {
    method,
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    headers,
  };

  if (site.ipFamily) {
    requestOptions.family = site.ipFamily;
  }

  return new Promise((resolve, reject) => {
    const req = client.request(requestOptions, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        responseBody += chunk;
      });
      res.on('end', () => {
        const statusCode = res.statusCode || 0;
        const parsed = parseMaybeJson(responseBody);

        if (statusCode < 200 || statusCode >= 300) {
          reject(new SignInError(`HTTP ${statusCode} from ${method} ${apiPath}`, {
            statusCode,
            response: scrubResponse(parsed),
            body: parsed === null ? responseBody.slice(0, 300) : undefined,
            authHint: getAuthHint(responseBody),
          }));
          return;
        }

        if (parsed === null) {
          reject(new SignInError(`Non-JSON response from ${method} ${apiPath}`, {
            body: responseBody.slice(0, 300),
            authHint: getAuthHint(responseBody),
          }));
          return;
        }

        resolve(parsed);
      });
    });

    req.setTimeout(site.timeoutMs, () => {
      req.destroy(new SignInError(`Request timed out after ${site.timeoutMs}ms: ${method} ${apiPath}`));
    });

    req.on('error', (error) => {
      if (error instanceof SignInError) {
        reject(error);
        return;
      }

      reject(new SignInError(error.message, {
        code: error.code || '',
        syscall: error.syscall || '',
      }));
    });
    req.end(body);
  });
}

function isRetryableNetworkError(error) {
  if (!(error instanceof SignInError)) return false;
  const code = error.details && error.details.code;
  if (['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPROTO'].includes(code)) return true;
  return /socket|tls|network|timeout|econnreset|disconnected/i.test(error.message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseMaybeJson(body) {
  if (!body.trim()) return {};

  try {
    return JSON.parse(body);
  } catch (error) {
    return null;
  }
}

function getAuthHint(body) {
  const text = body.toLowerCase();
  if (
    text.includes('not logged in') ||
    text.includes('login has expired') ||
    body.includes('未登录') ||
    body.includes('登录已过期')
  ) {
    return '登录态失效，请刷新 Cookie/session 或改用 System Access Token。';
  }

  if (text.includes('checking your browser') || text.includes('cloudflare')) {
    return '站点返回 Cloudflare 校验页，请从已通过校验的浏览器复制包含 cf_clearance 的完整 Cookie。';
  }

  return '';
}

function assertNewApiSuccess(result, context) {
  if (isSuccessResponse(result)) return;

  const message = getResponseMessage(result);
  const details = {
    response: scrubResponse(result),
  };
  const authHint = getFailureHint(message);
  if (authHint) details.authHint = authHint;

  throw new SignInError(message ? `${context}: ${message}` : `${context}: unexpected response`, {
    ...details,
  });
}

function getFailureHint(message) {
  if (/turnstile/i.test(message) || message.includes('Turnstile') || message.includes('验证')) {
    return [
      '站点要求 Cloudflare Turnstile token。',
      '纯 Node 定时脚本无法稳定自动生成这个短时 token；可临时从浏览器请求里复制后设置 <PREFIX>_TURNSTILE_TOKEN，或改用带真实浏览器模式的签到工具。',
    ].join('');
  }

  return '';
}

function isSuccessResponse(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.success === true) return true;
  if (result.ret === 1) return true;
  if (result.code === 0) return true;

  const message = getResponseMessage(result);
  return isAlreadyCheckedInMessage(message) || isCheckInSuccessMessage(message);
}

function getResponseMessage(result) {
  if (!result || typeof result !== 'object') return '';
  return String(result.message || result.msg || result.error || '');
}

function isAlreadyCheckedInMessage(message) {
  return /已.*签到|已经签到|already.*check/i.test(message);
}

function isCheckInSuccessMessage(message) {
  return /签到成功|check.?in.*success/i.test(message);
}

function scrubResponse(value) {
  if (!value || typeof value !== 'object') return value;
  const clone = Array.isArray(value) ? [...value] : { ...value };
  for (const key of Object.keys(clone)) {
    if (/cookie|token|authorization|password|session/i.test(key)) {
      clone[key] = '[redacted]';
    }
  }
  return clone;
}

function quotaToDollars(quota) {
  if (typeof quota !== 'number' || !Number.isFinite(quota)) return null;
  return quota / QUOTA_UNIT;
}

function describeQuota(quota) {
  const dollars = quotaToDollars(quota);
  if (dollars === null) return 'unknown quota';
  return `$${formatNumber(dollars)} (${quota.toLocaleString('en-US')} quota)`;
}

function formatNumber(value) {
  return value.toLocaleString('en-US', {
    maximumFractionDigits: 4,
  });
}

function describeUserInfo(result) {
  const data = result && typeof result === 'object' ? result.data || result : {};
  const quota = typeof data.quota === 'number' ? describeQuota(data.quota) : 'unknown';
  const used = typeof data.used_quota === 'number' ? describeQuota(data.used_quota) : 'unknown';
  const bonus = typeof data.bonus_quota === 'number' ? describeQuota(data.bonus_quota) : 'unknown';
  const username = data.username || data.display_name || data.email || data.id || 'unknown user';

  return {
    username,
    line: `账号：${username}\n余额：${quota}\n已用：${used}\n奖励余额：${bonus}`,
  };
}

function describeCheckInResult(result) {
  const message = getResponseMessage(result);
  const data = result && typeof result === 'object' ? result.data || {} : {};
  const awarded = typeof data.quota_awarded === 'number' ? describeQuota(data.quota_awarded) : '';
  const date = data.checkin_date || data.date || '';

  if (awarded && date) return `签到成功：${date}，奖励 ${awarded}`;
  if (awarded) return `签到成功：奖励 ${awarded}`;
  if (isAlreadyCheckedInMessage(message)) return message || '今日已签到';
  return message || '签到请求已完成';
}

async function runOneSite(site, args) {
  console.log(`[newapi:${site.id}] Start at ${new Date().toISOString()}`);
  console.log(`[newapi:${site.id}] Base URL: ${site.baseUrl}`);

  if (args.statusOnly) {
    const userInfo = await requestJson(site, 'GET', site.userInfoPath);
    assertNewApiSuccess(userInfo, 'Session validation failed');
    const beforeInfo = describeUserInfo(userInfo);
    console.log(`[newapi:${site.id}] Session OK: ${beforeInfo.username}`);
    console.log(`[newapi:${site.id}] Current balance: ${beforeInfo.line.replace(/\n/g, '; ')}`);

    return {
      site,
      success: true,
      message: ['状态检查成功', beforeInfo.line].join('\n'),
    };
  }

  if (site.preflightUserInfo) {
    const userInfo = await requestJson(site, 'GET', site.userInfoPath);
    assertNewApiSuccess(userInfo, 'Session validation failed');
    const beforeInfo = describeUserInfo(userInfo);
    console.log(`[newapi:${site.id}] Session OK: ${beforeInfo.username}`);
    console.log(`[newapi:${site.id}] Current balance: ${beforeInfo.line.replace(/\n/g, '; ')}`);
  }

  const checkInPath = site.turnstileToken
    ? appendQueryParam(site.checkInPath, 'turnstile', site.turnstileToken)
    : site.checkInPath;
  const checkInResult = await requestJson(site, 'POST', checkInPath);
  assertNewApiSuccess(checkInResult, 'Check-in failed');
  const checkInLine = describeCheckInResult(checkInResult);
  console.log(`[newapi:${site.id}] ${checkInLine}`);

  let afterLine = '';
  try {
    const afterUserInfo = await requestJson(site, 'GET', site.userInfoPath);
    assertNewApiSuccess(afterUserInfo, 'Failed to fetch user info after check-in');
    afterLine = describeUserInfo(afterUserInfo).line;
    console.log(`[newapi:${site.id}] Updated balance: ${afterLine.replace(/\n/g, '; ')}`);
  } catch (error) {
    afterLine = `签到后余额查询失败：${error.message}`;
    console.error(`[newapi:${site.id}] ${afterLine}`);
  }

  return {
    site,
    success: true,
    message: [checkInLine, afterLine].filter(Boolean).join('\n'),
  };
}

function appendQueryParam(rawPath, key, value) {
  const marker = rawPath.includes('?') ? '&' : '?';
  return `${rawPath}${marker}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const config = getConfig(args);
  const results = [];

  for (const site of config.sites) {
    try {
      const result = await runOneSite(site, args);
      results.push(result);
    } catch (error) {
      const details = error instanceof SignInError ? error.details : {};
      const hint = details && details.authHint ? `\n${details.authHint}` : '';
      const detailText = details && Object.keys(details).length > 0
        ? `\nDetails: ${JSON.stringify(details)}`
        : '';
      console.error(`[newapi:${site.id}] Failed: ${error.message}${hint}${detailText}`);
      results.push({
        site,
        success: false,
        message: `${error.message}${hint}`,
      });
    }
  }

  const body = results
    .map((result) => [
      `【${result.site.label}】${result.success ? '成功' : '失败'}`,
      result.message,
    ].join('\n'))
    .join('\n\n');

  await sendQinglongNotification(TASK_NAME, body);

  if (results.some((result) => !result.success)) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`[newapi] Failed: ${error.message}`);
    if (error instanceof SignInError && error.details && Object.keys(error.details).length > 0) {
      console.error(`[newapi] Details: ${JSON.stringify(error.details)}`);
    }
    sendQinglongNotification(TASK_NAME, ['执行失败', error.message].join('\n'))
      .finally(() => {
        process.exitCode = 1;
      });
  });
}

module.exports = {
  SignInError,
  buildSiteConfig,
  describeCheckInResult,
  describeQuota,
  describeUserInfo,
  getConfig,
  getQinglongNotifyModule,
  isAlreadyCheckedInMessage,
  isCheckInSuccessMessage,
  isQinglongEnvironment,
  normalizeBaseUrl,
  parseArgs,
  requestJson,
  run,
  runOneSite,
  sendQinglongNotification,
};
