#!/usr/bin/env node
// cron: 20 8 * * *
// new Env('黑与白福利站 Dashboard 签到和大转盘');
// description: 黑与白福利站 Dashboard 每日签到和幸运转盘，遇到 CAP/Cloudflare 验证时跳过并提示人工处理

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const DEFAULT_BASE_URL = 'https://cdk.hybgzs.com';
const DEFAULT_TIMEOUT_MS = 30000;
const TASK_NAME = '黑与白福利站 Dashboard 自动化';
const LOG_PREFIX = '[hybgzs-dashboard]';
const COOKIE_ENV_NAMES = [
  'HYB_DASHBOARD_COOKIE',
  'HYBGZS_COOKIE',
  'HYB_COOKIE',
  'HYB_CARDS_COOKIE',
];
const QUOTA_UNIT = 500000;

class HybDashboardError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'HybDashboardError';
    this.type = details.type || 'api_error';
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

function normalizeCookie(raw) {
  let cookie = String(raw || '').trim();
  if (cookie.toLowerCase().startsWith('cookie:')) {
    cookie = cookie.slice(cookie.indexOf(':') + 1).trim();
  }
  if (
    cookie.length >= 2 &&
    ((cookie.startsWith('"') && cookie.endsWith('"')) ||
      (cookie.startsWith("'") && cookie.endsWith("'")))
  ) {
    cookie = cookie.slice(1, -1).trim();
  }
  return cookie.replace(/\r?\n/g, '; ').replace(/;{2,}/g, ';').trim();
}

function normalizeBaseUrl(raw) {
  try {
    const url = new URL(raw);
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch (error) {
    throw new HybDashboardError(
      `环境变量 HYB_DASHBOARD_BASE_URL 格式无效: ${raw}\n请提供完整的 URL（如 ${DEFAULT_BASE_URL}）`,
      { type: 'config_error' }
    );
  }
}

function parsePositiveInteger(raw, fallback) {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getCookieFromEnv() {
  for (const envName of COOKIE_ENV_NAMES) {
    const cookie = normalizeCookie(process.env[envName]);
    if (cookie) return { cookie, envName };
  }
  return null;
}

function getConfig() {
  loadDotEnv();

  const cookieConfig = getCookieFromEnv();
  if (!cookieConfig) {
    throw new HybDashboardError(
      `缺少环境变量 HYB_DASHBOARD_COOKIE\n` +
        `请在青龙面板"环境变量"中添加：\n` +
        `  变量名: HYB_DASHBOARD_COOKIE\n` +
        `  变量值: 从浏览器复制的完整 Cookie 字符串\n\n` +
        `兼容变量: ${COOKIE_ENV_NAMES.slice(1).join(', ')}\n\n` +
        `获取方法：\n` +
        `  1. 登录 https://cdk.hybgzs.com\n` +
        `  2. 打开 https://cdk.hybgzs.com/dashboard\n` +
        `  3. F12 打开开发者工具 -> Network 标签\n` +
        `  4. 刷新页面，点击 dashboard、checkin 或 wheel 相关请求\n` +
        `  5. 复制 Request Headers 中完整 Cookie 值`,
      { type: 'config_error' }
    );
  }

  return {
    accountName: (process.env.HYB_DASHBOARD_ACCOUNT || '').trim(),
    baseUrl: normalizeBaseUrl(process.env.HYB_DASHBOARD_BASE_URL || DEFAULT_BASE_URL),
    cookie: cookieConfig.cookie,
    cookieEnvName: cookieConfig.envName,
    timeoutMs: parsePositiveInteger(process.env.HYB_DASHBOARD_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

function parseArgs(argv) {
  const args = {
    help: false,
    statusOnly: false,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--status-only') {
      args.statusOnly = true;
    } else {
      throw new HybDashboardError(`未知参数: ${arg}\n使用 --help 查看帮助`, { type: 'config_error' });
    }
  }

  return args;
}

function printUsage() {
  console.log(`使用方法: node hyb-dashboard.js [选项]

选项:
  --status-only   仅查询 dashboard 签到和大转盘状态，不执行动作
  -h, --help      显示此帮助信息

环境变量:
  HYB_DASHBOARD_COOKIE      推荐，完整浏览器 Cookie 字符串
  HYBGZS_COOKIE             兼容，完整浏览器 Cookie 字符串
  HYB_COOKIE                兼容，完整浏览器 Cookie 字符串
  HYB_CARDS_COOKIE          兼容，可复用 50 连抽脚本 Cookie
  HYB_DASHBOARD_ACCOUNT     可选，通知中展示的账号备注
  HYB_DASHBOARD_BASE_URL    可选，默认为 ${DEFAULT_BASE_URL}
  HYB_DASHBOARD_TIMEOUT_MS  可选，请求超时时间（毫秒），默认为 ${DEFAULT_TIMEOUT_MS}

行为:
  - 默认顺序：查询状态 -> 签到 -> 大转盘 -> 汇总通知
  - 当接口返回 capRequired=true 或 Cloudflare/challenge 时，脚本跳过对应动作并提示人工处理
  - 脚本不会破解 CAP/Cloudflare，也不会持久化 Cookie 或验证结果

青龙定时任务:
  20 8 * * * node /ql/data/scripts/hyb-dashboard.js`);
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
    path.join(__dirname, 'sendNotify.js'),
    path.join(__dirname, 'notify.js'),
    path.join(__dirname, '..', 'sendNotify.js'),
    path.join(__dirname, '..', 'notify.js'),
    path.join('/ql', 'data', 'scripts', 'sendNotify.js'),
    path.join('/ql', 'data', 'scripts', 'notify.js'),
    path.join('/ql', 'scripts', 'sendNotify.js'),
    path.join('/ql', 'scripts', 'notify.js'),
  ];

  for (const file of [...new Set(candidates)]) {
    if (!fs.existsSync(file)) continue;

    try {
      const mod = require(file);
      const sendNotify = typeof mod === 'function'
        ? mod
        : typeof mod?.sendNotify === 'function'
          ? mod.sendNotify
          : typeof mod?.default === 'function'
            ? mod.default
            : null;

      if (sendNotify) return { sendNotify, file };
    } catch (error) {
      console.error(`${LOG_PREFIX} 加载青龙通知模块失败: ${file}`);
      console.error(`${LOG_PREFIX} 错误: ${error.message}`);
    }
  }

  return null;
}

async function sendQinglongNotification(title, body) {
  if (!isQinglongEnvironment()) {
    console.log(`\n${title}\n${body}`);
    return false;
  }

  const notify = getQinglongNotifyModule();
  if (!notify) {
    console.log(`\n${title}\n${body}`);
    return false;
  }

  try {
    await Promise.resolve(notify.sendNotify(title, body));
    return true;
  } catch (error) {
    console.error(`${LOG_PREFIX} 青龙通知发送失败: ${error.message}`);
    return false;
  }
}

function getMessage(value) {
  if (!value || typeof value !== 'object') return '';
  return String(value.error || value.message || value.msg || value.reason || '').trim();
}

function isAuthMessage(message) {
  const text = String(message || '').toLowerCase();
  return text.includes('unauthorized') ||
    text.includes('forbidden') ||
    text.includes('expired') ||
    text.includes('invalid token') ||
    text.includes('not login') ||
    text.includes('not logged') ||
    text.includes('未登录') ||
    text.includes('未授权') ||
    text.includes('无权') ||
    text.includes('登录已过期');
}

function isChallengeMessage(message) {
  const text = String(message || '').toLowerCase();
  return text.includes('cloudflare') ||
    text.includes('challenge') ||
    text.includes('turnstile') ||
    text.includes('captcha') ||
    text.includes('cap') ||
    text.includes('nonce') ||
    text.includes('token 为空') ||
    text.includes('验证') ||
    text.includes('人机') ||
    text.includes('频率限制');
}

function classifyFailure(statusCode, message, looksLikeHtml) {
  if (looksLikeHtml || statusCode === 429 || isChallengeMessage(message)) return 'challenge_required';
  if (statusCode === 401 || statusCode === 403 || isAuthMessage(message)) return 'auth_failed';
  if (statusCode >= 500) return 'api_error';
  return 'api_error';
}

function scrubBody(body) {
  if (!body) return '';
  return String(body)
    .replace(/(__Secure-authjs\.session-token=)[^;\s<]+/g, '$1[redacted]')
    .replace(/(__Host-authjs\.csrf-token=)[^;\s<]+/g, '$1[redacted]')
    .replace(/(__Secure-nw-uid=)[^;\s<]+/g, '$1[redacted]')
    .replace(/(cf_clearance=)[^;\s<]+/g, '$1[redacted]')
    .replace(/(capToken["']?\s*[:=]\s*["'])[^"']+/gi, '$1[redacted]')
    .replace(/(capNonce["']?\s*[:=]\s*["'])[^"']+/gi, '$1[redacted]')
    .replace(/(Authorization:\s*Bearer\s+)[^\s<]+/gi, '$1[redacted]')
    .slice(0, 500);
}

function scrubResponse(value) {
  if (!value || typeof value !== 'object') return value;
  const clone = Array.isArray(value) ? [...value] : { ...value };
  for (const key of Object.keys(clone)) {
    if (/cookie|token|authorization|csrf|clearance|nonce/i.test(key)) {
      clone[key] = '[redacted]';
    } else if (clone[key] && typeof clone[key] === 'object') {
      clone[key] = scrubResponse(clone[key]);
    }
  }
  return clone;
}

function requestJson(config, apiPath, options = {}) {
  const method = options.method || 'GET';
  const body = options.body === undefined || options.body === null
    ? null
    : typeof options.body === 'string'
      ? options.body
      : JSON.stringify(options.body);
  const url = new URL(apiPath, config.baseUrl);
  const siteOrigin = new URL(config.baseUrl).origin;
  const client = url.protocol === 'http:' ? http : https;
  const refererPath = options.refererPath || '/dashboard';

  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    Cookie: config.cookie,
    DNT: '1',
    Origin: siteOrigin,
    Priority: method === 'GET' ? 'u=1, i' : 'u=0, i',
    Referer: `${siteOrigin}${refererPath}`,
    'Sec-CH-UA': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"macOS"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    ...options.headers,
  };

  if (body !== null) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
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

  return new Promise((resolve, reject) => {
    const req = client.request(requestOptions, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        responseBody += chunk;
      });
      res.on('end', () => {
        const statusCode = res.statusCode || 0;
        const contentType = String(res.headers['content-type'] || '');
        const trimmedBody = responseBody.trim();
        const looksLikeHtml = /^<!doctype html/i.test(trimmedBody) ||
          /^<html/i.test(trimmedBody) ||
          contentType.toLowerCase().includes('text/html');

        let parsed = null;
        if (trimmedBody && !looksLikeHtml) {
          try {
            parsed = JSON.parse(trimmedBody);
          } catch (error) {
            parsed = null;
          }
        }

        if (statusCode < 200 || statusCode >= 300) {
          const apiMessage = parsed ? getMessage(parsed) : '';
          const message = apiMessage || (
            looksLikeHtml
              ? `服务器返回 HTML，可能触发 Cloudflare/CAP/频率限制（HTTP ${statusCode}）`
              : `HTTP ${statusCode} - ${method} ${apiPath}`
          );
          reject(new HybDashboardError(message, {
            type: classifyFailure(statusCode, message, looksLikeHtml),
            statusCode,
            contentType,
            body: scrubBody(responseBody),
          }));
          return;
        }

        if (!parsed) {
          const message = looksLikeHtml
            ? '服务器返回 HTML，可能触发 Cloudflare/CAP 验证'
            : '服务器返回了非 JSON 格式的响应';
          reject(new HybDashboardError(message, {
            type: looksLikeHtml ? 'challenge_required' : 'schema_changed',
            statusCode,
            contentType,
            body: scrubBody(responseBody),
          }));
          return;
        }

        resolve(parsed);
      });
    });

    req.setTimeout(config.timeoutMs, () => {
      req.destroy(new HybDashboardError(`请求超时（${config.timeoutMs}ms）: ${method} ${apiPath}`, {
        type: 'network_error',
      }));
    });

    req.on('error', (error) => {
      reject(error instanceof HybDashboardError
        ? error
        : new HybDashboardError(`网络请求失败: ${error.message}`, {
          type: 'network_error',
          originalError: error.message,
        }));
    });

    if (body !== null) req.write(body);
    req.end();
  });
}

function assertSuccess(result, context) {
  if (!result || result.success !== true) {
    const message = getMessage(result) || '未知错误';
    throw new HybDashboardError(`${context}: ${message}`, {
      type: classifyFailure(200, message, false),
      response: scrubResponse(result),
    });
  }
}

function getData(result) {
  return result?.data && typeof result.data === 'object' ? result.data : result;
}

function getNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function quotaToCurrency(quota) {
  const value = getNumber(quota, 0) / QUOTA_UNIT;
  return `$${value.toFixed(2)}`;
}

function optionalQuotaToCurrency(quota) {
  return typeof quota === 'number' && Number.isFinite(quota) ? quotaToCurrency(quota) : null;
}

function formatLogicalDate(value) {
  if (!value || typeof value !== 'object') return '未知日期';
  const year = value.year || value.y;
  const month = value.month || value.m;
  const day = value.day || value.d;
  if (!year || !month || !day) return '未知日期';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function getAccountLabel(config, state) {
  if (config.accountName) return config.accountName;
  const candidates = [
    state?.dashboard?.user,
    state?.dashboard?.vipInfo?.user,
    state?.checkinConfig?.user,
    state?.wheel?.user,
  ];
  for (const item of candidates) {
    const name = item?.name || item?.username || item?.displayName || item?.email;
    if (name) return String(name);
  }
  return '当前账号';
}

function makeResult(action, type, message, extra = {}) {
  return { action, type, message, ...extra };
}

function getResultIcon(type) {
  if (type === 'success') return '✅';
  if (type === 'already_done') return '⏭️';
  if (type === 'challenge_required') return '🧩';
  if (type === 'skipped') return '⏭️';
  return '❌';
}

function isFailureResult(result) {
  return result.type === 'error' || result.type === 'auth_failed' || result.type === 'schema_changed';
}

function isChallengeError(error) {
  return error instanceof HybDashboardError && error.type === 'challenge_required';
}

function resultFromError(action, error) {
  const message = error instanceof HybDashboardError ? error.message : String(error);
  if (error instanceof HybDashboardError && error.type === 'auth_failed') {
    return makeResult(action, 'auth_failed', `${action}失败: Cookie 已失效或未登录，请更新 Cookie`);
  }
  if (isChallengeError(error)) {
    return makeResult(action, 'challenge_required', `${action}需要 CAP/Cloudflare 验证，脚本已跳过`);
  }
  if (error instanceof HybDashboardError && error.type === 'schema_changed') {
    return makeResult(action, 'schema_changed', `${action}失败: 接口结构变化或返回非预期内容`);
  }
  return makeResult(action, 'error', `${action}失败: ${message}`);
}

async function fetchState(config) {
  console.log(`${LOG_PREFIX} 开始查询 dashboard 状态`);

  const dashboardResult = await requestJson(config, '/api/dashboard/stats');
  assertSuccess(dashboardResult, '获取 dashboard 状态失败');

  const checkinStatusResult = await requestJson(config, '/api/checkin/status', {
    refererPath: '/gas-station/checkin',
  });
  assertSuccess(checkinStatusResult, '获取签到状态失败');

  const checkinConfigResult = await requestJson(config, '/api/checkin/config', {
    refererPath: '/gas-station/checkin',
  });
  assertSuccess(checkinConfigResult, '获取签到配置失败');

  const wheelEnabledResult = await requestJson(config, '/api/wheel/stats?type=enabled', {
    refererPath: '/entertainment/wheel',
  });
  assertSuccess(wheelEnabledResult, '获取转盘开关失败');

  const wheelResult = await requestJson(config, '/api/wheel', {
    refererPath: '/entertainment/wheel',
  });
  assertSuccess(wheelResult, '获取转盘状态失败');

  const wheelStatsResult = await requestJson(config, '/api/wheel/stats', {
    refererPath: '/entertainment/wheel',
  });
  assertSuccess(wheelStatsResult, '获取转盘统计失败');

  return {
    dashboard: getData(dashboardResult),
    checkinStatus: getData(checkinStatusResult),
    checkinConfig: getData(checkinConfigResult),
    wheelEnabled: getData(wheelEnabledResult),
    wheel: getData(wheelResult),
    wheelStats: getData(wheelStatsResult),
  };
}

function describeStatus(config, state) {
  const checkin = state.checkinConfig || {};
  const checkinStatus = state.checkinStatus || {};
  const wheel = state.wheel || {};
  const wheelEnabled = state.wheelEnabled || {};
  const stats = state.wheelStats || {};
  const lines = [
    `账号: ${getAccountLabel(config, state)}`,
    `日期: ${formatLogicalDate(checkin.logicalDate)}`,
    `签到功能: ${checkinStatus.enabled ? '开启' : '关闭'}`,
    `今日签到: ${checkin.hasCheckedInToday ? '已完成' : '未完成'}`,
    `签到 CAP: ${checkinStatus.capRequired ? '需要' : '不需要'}`,
    `预计签到奖励: ${optionalQuotaToCurrency(checkin.todayExpectedReward) || '未知'}`,
    `累计签到: ${getNumber(checkin.totalCheckinDays, 0)} 天`,
    `连续签到: ${getNumber(checkin.currentConsecutiveDays, 0)} 天`,
    `转盘功能: ${wheelEnabled.enabled ? '开启' : '关闭'}`,
    `转盘 CAP: ${wheel.capRequired ? '需要' : '不需要'}`,
    `今日剩余转盘: ${getNumber(wheel.remainingSpins, 0)}/${getNumber(wheel.totalSpins, 0)}`,
    `VIP: ${wheel.isVip ? '是' : '否'}${wheel.vipExtraSpins ? `，额外 ${wheel.vipExtraSpins} 次` : ''}`,
    `疯狂星期四: ${wheel.isThursday ? '是' : '否'}`,
  ];

  if (typeof state.dashboard?.walletBalance === 'number') {
    lines.push(`钱包余额: ${quotaToCurrency(state.dashboard.walletBalance)}`);
  }
  if (stats.todayTotalSpins !== undefined) {
    lines.push(`今日全站转盘: ${getNumber(stats.todayTotalUsers, 0)} 人 / ${getNumber(stats.todayTotalSpins, 0)} 次 / 中奖率 ${stats.todayWinRate || '未知'}%`);
  }

  return lines.join('\n');
}

function summarizeCheckinSuccess(data) {
  const lines = ['签到成功'];
  const message = data?.message || data?.result?.message;
  if (message) lines.push(String(message));
  const reward = optionalQuotaToCurrency(data?.rewardQuota ?? data?.reward ?? data?.quota ?? data?.todayExpectedReward);
  if (reward) lines.push(`奖励: ${reward}`);
  const wallet = optionalQuotaToCurrency(data?.walletBalance);
  if (wallet) lines.push(`钱包余额: ${wallet}`);
  if (Array.isArray(data?.grantedAchievements) && data.grantedAchievements.length > 0) {
    lines.push(`新成就: ${data.grantedAchievements.length} 个`);
  }
  return lines.join('\n');
}

function summarizeWheelSuccess(data) {
  const prize = data?.prize || {};
  const prizeName = prize.name || data?.prizeName || '未返回奖品名称';
  const amount = prize.amount ?? data?.rewardQuota ?? data?.amount;
  const reward = optionalQuotaToCurrency(amount);
  const lines = [`大转盘成功: ${prizeName}`];
  if (reward) lines.push(`奖励: ${reward}`);
  if (typeof data?.remainingSpins === 'number') lines.push(`剩余次数: ${data.remainingSpins}`);
  if (data?.isGuarantee) lines.push('触发保底');
  if (Array.isArray(data?.grantedAchievements) && data.grantedAchievements.length > 0) {
    lines.push(`新成就: ${data.grantedAchievements.length} 个`);
  }
  return lines.join('\n');
}

async function performCheckin(config, state) {
  const status = state.checkinStatus || {};
  const data = state.checkinConfig || {};

  if (status.enabled === false) {
    return makeResult('签到', 'skipped', '签到功能已关闭');
  }
  if (data.hasCheckedInToday === true) {
    return makeResult('签到', 'already_done', '今日已签到');
  }
  if (status.capRequired === true || data.capRequired === true) {
    return makeResult('签到', 'challenge_required', '签到需要 CAP 验证，脚本未执行；请在浏览器完成验证后重试');
  }

  try {
    const result = await requestJson(config, '/api/checkin', {
      method: 'POST',
      refererPath: '/gas-station/checkin',
      body: { capToken: '', capNonce: '', solveElapsedMs: 0 },
    });
    assertSuccess(result, '签到失败');
    const resultData = getData(result);
    if (resultData?.capRequired === true) {
      return makeResult('签到', 'challenge_required', '签到需要 CAP 验证，脚本未执行成功；请在浏览器完成验证后重试');
    }
    return makeResult('签到', 'success', summarizeCheckinSuccess(resultData), { data: resultData });
  } catch (error) {
    return resultFromError('签到', error);
  }
}

async function performWheel(config, state) {
  const enabled = state.wheelEnabled || {};
  const data = state.wheel || {};
  const remaining = getNumber(data.remainingSpins, 0);

  if (enabled.enabled === false) {
    return makeResult('大转盘', 'skipped', '转盘功能已关闭');
  }
  if (remaining <= 0) {
    return makeResult('大转盘', 'already_done', '今日转盘次数不足或已用完');
  }
  if (data.capRequired === true) {
    return makeResult('大转盘', 'challenge_required', '大转盘需要 CAP 验证，脚本未执行；请在浏览器完成验证后重试');
  }

  try {
    const result = await requestJson(config, '/api/wheel', {
      method: 'POST',
      refererPath: '/entertainment/wheel',
      body: {},
    });
    assertSuccess(result, '大转盘失败');
    const resultData = getData(result);
    if (resultData?.capRequired === true) {
      return makeResult('大转盘', 'challenge_required', '大转盘需要 CAP 验证，脚本未执行成功；请在浏览器完成验证后重试');
    }
    return makeResult('大转盘', 'success', summarizeWheelSuccess(resultData), { data: resultData });
  } catch (error) {
    return resultFromError('大转盘', error);
  }
}

function formatResult(result) {
  if (isFailureResult(result)) {
    return `${getResultIcon(result.type)} 发生异常：${result.action}: ${result.message}`;
  }
  return `${getResultIcon(result.type)} ${result.action}: ${result.message}`;
}

function formatSummary(config, state, results, statusOnly = false) {
  const lines = [
    `账号: ${getAccountLabel(config, state)}`,
    statusOnly ? '📊 状态查询' : '📋 执行汇总',
    '',
    describeStatus(config, state),
  ];

  if (!statusOnly) {
    lines.push('', '执行结果:');
    for (const result of results) lines.push(formatResult(result));
  }

  return lines.join('\n');
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const config = getConfig();
  console.log(`${LOG_PREFIX} 开始执行 - ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  console.log(`${LOG_PREFIX} 使用 Cookie 变量: ${config.cookieEnvName}`);

  const state = await fetchState(config);
  console.log(`${LOG_PREFIX} 状态查询成功`);
  console.log(describeStatus(config, state));

  if (args.statusOnly) {
    await sendQinglongNotification(TASK_NAME, formatSummary(config, state, [], true));
    return;
  }

  const results = [];
  const checkinResult = await performCheckin(config, state);
  results.push(checkinResult);
  console.log(`${LOG_PREFIX} ${formatResult(checkinResult)}`);

  const wheelResult = await performWheel(config, state);
  results.push(wheelResult);
  console.log(`${LOG_PREFIX} ${formatResult(wheelResult)}`);

  await sendQinglongNotification(TASK_NAME, formatSummary(config, state, results));

  if (results.some(isFailureResult)) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  run().catch((error) => {
    const errorMsg = error instanceof HybDashboardError && error.type === 'auth_failed'
      ? 'Cookie 已失效或未登录，请更新 HYB_DASHBOARD_COOKIE'
      : error instanceof HybDashboardError && error.type === 'challenge_required'
        ? '站点要求 CAP/Cloudflare 验证，请在浏览器完成验证后重试'
        : error instanceof HybDashboardError
          ? error.message
          : `未知错误: ${error.message || String(error)}`;

    console.error(`${LOG_PREFIX} 执行失败: ${errorMsg}`);
    if (error instanceof HybDashboardError && error.details && Object.keys(error.details).length > 0) {
      console.error(`${LOG_PREFIX} 详细信息: ${JSON.stringify(scrubResponse(error.details), null, 2)}`);
    }

    sendQinglongNotification(TASK_NAME, `❌ 发生异常：执行失败\n\n${errorMsg}`)
      .finally(() => {
        process.exitCode = 1;
      });
  });
}

module.exports = {
  COOKIE_ENV_NAMES,
  HybDashboardError,
  classifyFailure,
  describeStatus,
  fetchState,
  formatSummary,
  getConfig,
  getQinglongNotifyModule,
  normalizeBaseUrl,
  normalizeCookie,
  parseArgs,
  performCheckin,
  performWheel,
  quotaToCurrency,
  requestJson,
  run,
  scrubBody,
  scrubResponse,
  sendQinglongNotification,
};
