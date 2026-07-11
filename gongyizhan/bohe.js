#!/usr/bin/env node
// cron: 10 8 * * *
// new Env('薄荷签到');
// description: 薄荷公益站每日签到，优先使用青龙通知模块发送结果

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const DEFAULT_BASE_URL = 'https://up.x666.me';
const DEFAULT_TIMEOUT_MS = 30000;
const QUOTA_PER_TIME = 500;
const TASK_NAME = '薄荷签到';

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

function getConfig() {
  loadDotEnv();

  const cookie = (process.env.UP_X666_COOKIE || '').trim();
  if (!cookie) {
    throw new SignInError(
      '缺少环境变量 UP_X666_COOKIE\n' +
      '请在青龙面板"环境变量"中添加：\n' +
      '  变量名: UP_X666_COOKIE\n' +
      '  变量值: 从浏览器复制的完整 Cookie 字符串\n\n' +
      '获取方法：\n' +
      '  1. 登录 https://up.x666.me\n' +
      '  2. F12 打开开发者工具 → Network 标签\n' +
      '  3. 刷新页面，点击任意请求\n' +
      '  4. 找到 Request Headers 中的 Cookie 行\n' +
      '  5. 复制完整的 Cookie 值'
    );
  }

  const baseUrl = normalizeBaseUrl(process.env.UP_X666_BASE_URL || DEFAULT_BASE_URL);
  const timeoutMs = parsePositiveInteger(process.env.UP_X666_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

  return { baseUrl, cookie, timeoutMs };
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
      throw new SignInError(`未知参数: ${arg}\n使用 --help 查看帮助`);
    }
  }

  return args;
}

function printUsage() {
  console.log(`使用方法: node up-x666-signin.js [选项]

选项:
  --status-only   仅验证会话并显示今日签到状态，不执行签到
  -h, --help      显示此帮助信息

环境变量:
  UP_X666_COOKIE      必需，从浏览器复制的完整 Cookie 字符串
  UP_X666_BASE_URL    可选，默认为 ${DEFAULT_BASE_URL}
  UP_X666_TIMEOUT_MS  可选，请求超时时间（毫秒），默认为 ${DEFAULT_TIMEOUT_MS}

示例:
  # 执行签到
  node up-x666-signin.js

  # 仅查看状态
  node up-x666-signin.js --status-only

  # 青龙面板定时任务
  # cron: 0 10 8 * * *
  # 环境变量中配置 UP_X666_COOKIE`);
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
      console.error(`[up.x666] 加载青龙通知模块失败: ${file}`);
      console.error(`[up.x666] 错误: ${error.message}`);
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
    console.error(`[up.x666] 青龙通知发送失败: ${error.message}`);
    return false;
  }
}

function normalizeBaseUrl(raw) {
  try {
    const url = new URL(raw);
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch (error) {
    throw new SignInError(`环境变量 UP_X666_BASE_URL 格式无效: ${raw}\n请提供完整的 URL（如 https://up.x666.me）`);
  }
}

function parsePositiveInteger(raw, fallback) {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function requestJson(config, apiPath, options = {}) {
  const method = options.method || 'GET';
  const url = new URL(apiPath, config.baseUrl);
  const siteOrigin = new URL(config.baseUrl).origin;
  const client = url.protocol === 'http:' ? http : https;

  const headers = {
    Accept: 'application/json',
    Cookie: config.cookie,
    Origin: siteOrigin,
    Referer: `${siteOrigin}/`,
    'User-Agent': 'up-x666-daily-signin/1.0 (+https://up.x666.me)',
    ...options.headers,
  };

  if (method !== 'GET' && method !== 'HEAD') {
    headers['Content-Length'] = '0';
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
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        const statusCode = res.statusCode || 0;
        if (statusCode < 200 || statusCode >= 300) {
          reject(new SignInError(
            `HTTP ${statusCode} - ${method} ${apiPath}\n` +
            `响应内容: ${body.slice(0, 200)}...`,
            { statusCode, body: body.slice(0, 300) }
          ));
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new SignInError(
            `服务器返回了非 JSON 格式的响应\n` +
            `请求: ${method} ${apiPath}\n` +
            `响应内容: ${body.slice(0, 200)}...`,
            { body: body.slice(0, 300) }
          ));
        }
      });
    });

    req.setTimeout(config.timeoutMs, () => {
      req.destroy(new SignInError(`请求超时（${config.timeoutMs}ms）: ${method} ${apiPath}`));
    });

    req.on('error', (error) => {
      reject(new SignInError(
        `网络请求失败: ${error.message}\n` +
        `请求: ${method} ${apiPath}\n` +
        `请检查网络连接和站点地址`,
        { originalError: error }
      ));
    });
    req.end();
  });
}

function assertSuccess(result, context) {
  if (!result || result.success !== true) {
    const message = result && (result.message || result.error)
      ? `${context}: ${result.message || result.error}`
      : `${context}: 未知错误`;
    throw new SignInError(message, { response: scrubResponse(result) });
  }
}

function scrubResponse(value) {
  if (!value || typeof value !== 'object') return value;
  const clone = { ...value };
  delete clone.cookie;
  delete clone.token;
  delete clone.access_token;
  delete clone.refresh_token;
  return clone;
}

function canSpin(status) {
  return status && status.can_spin === true;
}

function getUnavailableReason(status) {
  if (status && status.can_spin === false) return '今天已签到，无需重复转盘';
  return '当前不可签到，接口未返回可转盘状态';
}

function quotaToTimes(quota) {
  const numericQuota = toFiniteNumber(quota);
  if (numericQuota === null) return null;
  return numericQuota / QUOTA_PER_TIME;
}

function describeQuota(quota) {
  const numericQuota = toFiniteNumber(quota);
  const times = quotaToTimes(quota);
  if (numericQuota === null || times === null) return '未知奖励';
  return `${times.toLocaleString('zh-CN')} 次 (${numericQuota.toLocaleString('zh-CN')} 额度)`;
}

function toFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function describeSpinPrize(spinResult) {
  const quotaCandidates = [
    spinResult && spinResult.quota,
    spinResult && spinResult.quota_amount,
    spinResult && spinResult.data && spinResult.data.quota,
    spinResult && spinResult.data && spinResult.data.quota_amount,
  ];

  for (const quota of quotaCandidates) {
    if (toFiniteNumber(quota) !== null) return describeQuota(quota);
  }

  const label = spinResult && typeof spinResult.label === 'string'
    ? spinResult.label.trim()
    : '';
  return label || '奖励数据缺失';
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const config = getConfig();
  console.log(`[up.x666] 开始执行签到检查 - ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);

  // 验证会话
  let userInfo;
  try {
    userInfo = await requestJson(config, '/api/user/info');
    assertSuccess(userInfo, '会话验证失败');
  } catch (error) {
    const errorMsg = error instanceof SignInError ? error.message : String(error);
    console.error(`[up.x666] ❌ 会话验证失败`);
    console.error(`[up.x666] 错误详情: ${errorMsg}`);

    await sendQinglongNotification(
      TASK_NAME,
      `❌ 发生异常：会话验证失败\n\n${errorMsg}\n\n请更新环境变量 UP_X666_COOKIE`
    );
    throw error;
  }

  const username = userInfo.username || userInfo.name || userInfo.linux_do_id || 'unknown user';
  console.log(`[up.x666] ✅ 会话验证成功: ${username}`);

  // 获取签到状态
  let status;
  try {
    status = await requestJson(config, '/api/checkin/status');
    assertSuccess(status, '获取签到状态失败');
  } catch (error) {
    const errorMsg = error instanceof SignInError ? error.message : String(error);
    console.error(`[up.x666] ❌ 获取签到状态失败`);
    console.error(`[up.x666] 错误详情: ${errorMsg}`);

    await sendQinglongNotification(
      TASK_NAME,
      `账号: ${username}\n❌ 发生异常：获取签到状态失败\n\n${errorMsg}`
    );
    throw error;
  }

  if (args.statusOnly) {
    console.log(`[up.x666] 📊 状态查询模式: 今日${canSpin(status) ? '未' : '已'}签到`);
    if (typeof status.total_quota === 'number') {
      console.log(`[up.x666] 📊 累计获得: ${describeQuota(status.total_quota)}`);
    }
    return;
  }

  if (!canSpin(status)) {
    const reason = getUnavailableReason(status);
    console.log(`[up.x666] ⏭️  ${reason}`);
    if (typeof status.total_quota === 'number') {
      console.log(`[up.x666] 📊 累计获得: ${describeQuota(status.total_quota)}`);
    }
    await sendQinglongNotification(
      TASK_NAME,
      `账号: ${username}\n${reason}`
    );
    return;
  }

  // 执行签到
  console.log('[up.x666] 🎰 开始签到转盘...');
  let spinResult;
  try {
    spinResult = await requestJson(config, '/api/checkin/spin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    assertSuccess(spinResult, '签到失败');
  } catch (error) {
    const errorMsg = error instanceof SignInError ? error.message : String(error);
    console.error(`[up.x666] ❌ 签到失败`);
    console.error(`[up.x666] 错误详情: ${errorMsg}`);

    await sendQinglongNotification(
      TASK_NAME,
      `账号: ${username}\n❌ 发生异常：签到失败\n\n${errorMsg}`
    );
    throw error;
  }

  const prize = describeSpinPrize(spinResult);
  const level = spinResult.level !== undefined ? `level ${spinResult.level}` : 'unknown level';

  console.log(`[up.x666] 🎉 签到成功!`);
  console.log(`[up.x666] 📦 等级: ${level}`);
  console.log(`[up.x666] 🎁 奖励: ${prize}`);

  await sendQinglongNotification(
    TASK_NAME,
    `账号: ${username}\n✅ 签到成功\n\n等级: ${level}\n奖励: ${prize}`
  );
}

if (require.main === module) {
  run().catch((error) => {
    const errorMsg = error instanceof SignInError
      ? error.message
      : `未知错误: ${error.message || String(error)}`;

    console.error(`[up.x666] ❌ 执行失败`);
    console.error(`[up.x666] ${errorMsg}`);

    if (error instanceof SignInError && error.details && Object.keys(error.details).length > 0) {
      console.error(`[up.x666] 详细信息: ${JSON.stringify(error.details, null, 2)}`);
    }

    sendQinglongNotification(TASK_NAME, `❌ 发生异常：执行失败\n\n${errorMsg}`)
      .finally(() => {
        process.exitCode = 1;
      });
  });
}

module.exports = {
  SignInError,
  describeQuota,
  describeSpinPrize,
  getConfig,
  getQinglongNotifyModule,
  getUnavailableReason,
  isQinglongEnvironment,
  normalizeBaseUrl,
  parseArgs,
  quotaToTimes,
  requestJson,
  run,
  canSpin,
  sendQinglongNotification,
};
