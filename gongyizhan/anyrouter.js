#!/usr/bin/env node
/**
 * cron: 5 8 * * *
 * new Env('AnyRouter 签到');
 *
 * 环境变量: ANYROUTER_COOKIE="session=xxx; acw_tc=xxx; acw_sc__v2=xxx"
 */

const vm = require('node:vm');

const SITE_URL = 'https://anyrouter.top';
const USER_ID = '68910';
const QUOTA_PER_YUAN = 500000;
const TIMEOUT_MS = 15000;
const MAX_CHALLENGE_RETRIES = 2;
const TASK_TITLE = 'AnyRouter 自动签到';

class AnyRouterError extends Error {
  constructor(type, message) {
    super(message);
    this.name = 'AnyRouterError';
    this.type = type;
  }
}

// 青龙通知
async function notify(title, content) {
  try {
    const mod = require('./sendNotify');
    const sendNotify = typeof mod === 'function'
      ? mod
      : typeof mod?.sendNotify === 'function'
        ? mod.sendNotify
        : typeof mod?.default === 'function'
          ? mod.default
          : null;

    if (sendNotify) {
      return await Promise.resolve(sendNotify(title, content));
    }
  } catch (error) {
    console.error(`[AnyRouter] 青龙通知发送失败: ${error.message}`);
  }

  console.log(`\n${title}\n${content}`);
  return false;
}

function quotaToYuan(quota) {
  const value = Number(quota);
  if (!Number.isFinite(value)) {
    return 0;
  }

  return value / QUOTA_PER_YUAN;
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
  return text.includes('unauthorized')
    || text.includes('forbidden')
    || text.includes('expired')
    || text.includes('invalid token')
    || text.includes('access token')
    || text.includes('not login')
    || text.includes('not logged')
    || text.includes('未登录')
    || text.includes('未授权')
    || text.includes('无权')
    || text.includes('凭证');
}

function isAlreadyCheckedMessage(message) {
  const text = String(message || '').toLowerCase();
  return text.includes('already checked')
    || text.includes('already signed')
    || text.includes('already sign')
    || text.includes('今日已签到')
    || text.includes('今天已签到')
    || text.includes('已经签到')
    || text.includes('已签到')
    || text.includes('重复签到');
}

function isMissingEndpoint(status, message) {
  const text = String(message || '').toLowerCase();
  return status === 404
    || text.includes('invalid url')
    || text.includes('not found')
    || text.includes('endpoint not found')
    || text.includes('not support')
    || text.includes('不支持');
}

function splitSetCookieHeader(header) {
  if (!header) {
    return [];
  }

  return String(header).split(/,(?=\s*[^;,]+=)/).map(value => value.trim()).filter(Boolean);
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }

  return splitSetCookieHeader(headers.get('set-cookie'));
}

function upsertCookie(cookie, name, value) {
  const items = cookie.split(';').map(item => item.trim()).filter(Boolean);
  let found = false;
  const nextItems = items.map((item) => {
    const index = item.indexOf('=');
    if (index <= 0 || item.slice(0, index).trim() !== name) {
      return item;
    }

    found = true;
    return `${name}=${value}`;
  });

  if (!found) {
    nextItems.push(`${name}=${value}`);
  }

  return nextItems.join('; ');
}

function mergeSetCookies(cookie, setCookieHeaders) {
  return setCookieHeaders.reduce((current, header) => {
    const pair = String(header).split(';')[0]?.trim();
    if (!pair) {
      return current;
    }

    const index = pair.indexOf('=');
    if (index <= 0) {
      return current;
    }

    return upsertCookie(current, pair.slice(0, index).trim(), pair.slice(index + 1));
  }, cookie);
}

function isChallengeResponse(response, text) {
  const contentType = response.headers.get('content-type') || '';
  const edgeError = response.headers.get('x-tengine-error') || '';
  return contentType.toLowerCase().includes('text/html')
    && (/var\s+arg1\s*=|acw_sc__v2|cdn_sec_tc|<script/i.test(text) || Boolean(edgeError));
}

function extractScript(html) {
  const match = html.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
  return match ? match[1] : html;
}

function solveAcwScV2Challenge(html) {
  const cookies = [];
  const sandbox = {
    Date,
    RegExp,
    parseInt,
    decodeURIComponent,
    String,
    Math,
    Boolean,
    console: { log() {}, error() {}, warn() {} },
    document: {
      location: { reload() {} },
      set cookie(value) {
        cookies.push(String(value));
      },
      get cookie() {
        return cookies.join('; ');
      }
    },
    window: {}
  };

  sandbox.window = sandbox;
  vm.createContext(sandbox, { codeGeneration: { strings: true, wasm: false } });
  vm.runInContext(extractScript(html), sandbox, { timeout: 3000 });

  const acwPair = cookies
    .map(value => value.split(';')[0])
    .find(value => value.startsWith('acw_sc__v2='));

  return acwPair ? acwPair.slice('acw_sc__v2='.length) : null;
}

function buildHeaders(cookie, extraHeaders = {}) {
  return {
    'Cookie': cookie,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Origin': SITE_URL,
    'Referer': `${SITE_URL}/console/personal`,
    'New-Api-User': USER_ID,
    'Veloera-User': USER_ID,
    'User-id': USER_ID,
    'X-Requested-With': 'XMLHttpRequest',
    ...extraHeaders
  };
}

async function requestText(state, path, options = {}) {
  const url = `${SITE_URL}${path}`;
  let lastChallengeError = null;

  for (let attempt = 0; attempt <= MAX_CHALLENGE_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        body: options.body,
        headers: buildHeaders(state.cookie, options.headers),
        signal: controller.signal
      });
      const text = await response.text();
      state.cookie = mergeSetCookies(state.cookie, getSetCookieHeaders(response.headers));

      if (!isChallengeResponse(response, text)) {
        return { response, text };
      }

      try {
        const acwScV2 = solveAcwScV2Challenge(text);
        if (!acwScV2) {
          throw new Error('未生成 acw_sc__v2');
        }
        state.cookie = upsertCookie(state.cookie, 'acw_sc__v2', acwScV2);
        lastChallengeError = null;
      } catch (error) {
        lastChallengeError = error;
        break;
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new AnyRouterError('error', `请求超时: ${path}`);
      }

      throw new AnyRouterError('error', `网络请求失败: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  const reason = lastChallengeError ? `: ${lastChallengeError.message}` : '';
  throw new AnyRouterError(
    'challenge_failed',
    `站点返回防护验证，自动刷新 acw_sc__v2 失败${reason}。Cookie 未必失效，请稍后重试或重新从浏览器复制完整 Cookie。`
  );
}

async function requestJson(state, path, options = {}) {
  const { response, text } = await requestText(state, path, options);
  const data = parseJsonSafe(text);

  if (response.status === 401 || response.status === 403) {
    const message = extractMessage(data) || `HTTP ${response.status}`;
    throw new AnyRouterError('auth_failed', `Cookie 已失效或无权限: ${message}`);
  }

  if (!data) {
    throw new AnyRouterError('error', `接口返回非 JSON 响应: HTTP ${response.status}`);
  }

  return { status: response.status, data };
}

async function fetchUserSelf(state) {
  const { status, data } = await requestJson(state, '/api/user/self');
  const message = extractMessage(data);

  if (data?.success && data?.data) {
    return data.data;
  }

  if (isAuthMessage(message)) {
    throw new AnyRouterError('auth_failed', `Cookie 已失效或无权限: ${message}`);
  }

  throw new AnyRouterError('error', `登录状态验证失败: ${message || `HTTP ${status}`}`);
}

function analyzeCheckinResponse(status, data) {
  const message = extractMessage(data);

  if (data?.success === true) {
    const reward = data.data?.quota_awarded ?? data.data?.reward;
    return {
      type: 'success',
      message: message || '签到成功',
      reward
    };
  }

  if (isAlreadyCheckedMessage(message)) {
    return { type: 'already_checked', message: '今日已签到' };
  }

  if (status === 401 || status === 403 || isAuthMessage(message)) {
    return {
      type: 'auth_failed',
      message: message ? `Cookie 已失效或无权限: ${message}` : 'Cookie 已失效或无权限'
    };
  }

  if (isMissingEndpoint(status, message)) {
    return { type: 'missing_endpoint', message: message || `HTTP ${status}` };
  }

  return {
    type: 'error',
    message: message ? `签到失败: ${message}` : `签到失败: HTTP ${status}`
  };
}

async function tryCheckin(state) {
  const endpoints = [
    { path: '/api/user/checkin', options: { method: 'POST' } },
    {
      path: '/api/user/sign_in',
      options: {
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'application/json' }
      }
    }
  ];
  let lastResult = null;

  for (const endpoint of endpoints) {
    try {
      const { status, data } = await requestJson(state, endpoint.path, endpoint.options);
      const result = analyzeCheckinResponse(status, data);

      if (result.type === 'missing_endpoint') {
        lastResult = result;
        continue;
      }

      return result;
    } catch (error) {
      if (error instanceof AnyRouterError) {
        if (error.type === 'auth_failed' || error.type === 'challenge_failed') {
          return { type: error.type, message: error.message };
        }

        lastResult = { type: 'error', message: error.message };
        continue;
      }

      lastResult = { type: 'error', message: error.message };
    }
  }

  return lastResult?.type === 'missing_endpoint'
    ? { type: 'error', message: `未找到可用签到接口: ${lastResult.message}` }
    : lastResult || { type: 'error', message: '签到失败: 未获得接口响应' };
}

function formatReward(reward) {
  const value = Number(reward);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return (value / QUOTA_PER_YUAN).toFixed(4);
}

function formatBalance(userData) {
  const balance = quotaToYuan(userData?.quota);
  const todayIncome = userData?.today_income !== undefined
    ? quotaToYuan(userData.today_income)
    : null;

  return todayIncome !== null && todayIncome > 0
    ? `今日收益: ${todayIncome.toFixed(4)} 元\n余额: ${balance.toFixed(4)} 元`
    : `余额: ${balance.toFixed(4)} 元`;
}

function formatResult(result, userData) {
  const balanceText = userData ? `\n\n${formatBalance(userData)}` : '';

  if (result.type === 'success') {
    const reward = formatReward(result.reward);
    const rewardText = reward ? `，获得 ${reward} 元` : '';
    return `✅ ${result.message}${rewardText}${balanceText}`;
  }

  if (result.type === 'already_checked') {
    return `⏭️ 今日已签到${balanceText}`;
  }

  if (result.type === 'auth_failed') {
    return `❌ ${result.message}\n\n请更新环境变量 ANYROUTER_COOKIE`;
  }

  if (result.type === 'challenge_failed') {
    return `⚠️ ${result.message}`;
  }

  return `❌ ${result.message}${balanceText}`;
}

async function main() {
  const cookie = process.env.ANYROUTER_COOKIE?.trim();

  if (!cookie) {
    await notify(TASK_TITLE, '❌ 未配置环境变量 ANYROUTER_COOKIE');
    process.exit(1);
  }

  const state = { cookie };

  try {
    await fetchUserSelf(state);
    const checkinResult = await tryCheckin(state);
    let userData = null;

    try {
      userData = await fetchUserSelf(state);
    } catch (error) {
      if (checkinResult.type !== 'success' && checkinResult.type !== 'already_checked') {
        throw error;
      }
    }

    await notify(TASK_TITLE, formatResult(checkinResult, userData));

    if (checkinResult.type !== 'success' && checkinResult.type !== 'already_checked') {
      process.exit(1);
    }
  } catch (error) {
    const result = error instanceof AnyRouterError
      ? { type: error.type, message: error.message }
      : { type: 'error', message: `执行异常: ${error.message}` };

    await notify(TASK_TITLE, formatResult(result));
    process.exit(1);
  }
}

main().catch(async (error) => {
  await notify(TASK_TITLE, `❌ 执行异常: ${error.message}`);
  process.exitCode = 1;
});
