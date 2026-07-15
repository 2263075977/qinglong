#!/usr/bin/env node
// cron: */30 * * * *
// new Env('黑与白福利站 轻松农场');
// description: 黑与白福利站轻松农场自动收获、护理、补种杨桃、变现与补货

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const DEFAULT_BASE_URL = 'https://cdk.hybgzs.com';
const DEFAULT_TIMEOUT_MS = 30000;
const TASK_NAME = '黑与白福利站 轻松农场';
const LOG_PREFIX = '[hybgzs-farm]';
const FARM_REFERER_PATH = '/entertainment/farm';
const DEFAULT_ACTION = 'status';
const FARM_ACTIONS = new Set(['status', 'harvest-all', 'care-all', 'plant-batch', 'auto']);
const COOKIE_ENV_NAMES = [
  'HYB_FARM_COOKIE',
  'HYB_DASHBOARD_COOKIE',
  'HYBGZS_COOKIE',
  'HYB_COOKIE',
  'HYB_CARDS_COOKIE',
];

// 主种锁定杨桃 starfruit（VIP 最优，10h 周期契合 30min cron）。
// 名字/ID 双匹配，回退到 HYB_FARM_SEED_ID，再回退到内置常量。
const MAIN_SEED_ID = 'starfruit';
const MAIN_SEED_ALIASES = ['starfruit', '杨桃'];
const MAX_SLIPPAGE_BPS = 300; // 回收滑点保护：超过 3% 自动拒绝
const DEFAULT_MIN_ENERGY = 10; // 护理前保留的体力阈值
const DEFAULT_SELL_RATIO = 0.95; // 当前回收价 ≥ 7 日均价 × 该比例才卖（躲低谷）
const DEFAULT_FORCE_SELL_USAGE = 0.85; // 仓库使用率 ≥ 该值时无视价格强制卖（防满仓卡死）
// 卖出前保留的种子数，默认 0。安全前提：用户更新脚本前会手动一次性把 starfruit 种子全部种下（库存清零），
// 此后库存中出现的 starfruit 均为收获的果实（种子/果实同池），故 0 保留不会误卖种子。
// 若日后会“买种子囤着分批种”，需调高此值兜底，否则未种的种子会被当盈余卖出。
const DEFAULT_SEED_RESERVE = 0;

class HybFarmError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'HybFarmError';
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
    throw new HybFarmError(
      `环境变量 HYB_FARM_BASE_URL 格式无效: ${raw}\n请提供完整的 URL（如 ${DEFAULT_BASE_URL}）`,
      { type: 'config_error' }
    );
  }
}

function parsePositiveInteger(raw, fallback = null) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number.parseInt(String(raw), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseBoolean(raw, fallback = false) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(raw).trim().toLowerCase());
}

function parseFloatOrDefault(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number.parseFloat(String(raw));
  return Number.isFinite(value) ? value : fallback;
}

function parseNonNegativeInteger(raw, fallback = 0) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number.parseInt(String(raw), 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeDefaultAction(raw = DEFAULT_ACTION) {
  const action = String(raw || DEFAULT_ACTION).trim().toLowerCase();
  if (!FARM_ACTIONS.has(action)) {
    throw new HybFarmError(
      `环境变量 HYB_FARM_DEFAULT_ACTION 无效: ${raw}\n` +
        `允许值: ${[...FARM_ACTIONS].join(', ')}`,
      { type: 'config_error' }
    );
  }
  return action;
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
    throw new HybFarmError(
      `缺少环境变量 HYB_FARM_COOKIE\n` +
        `请在青龙面板"环境变量"中添加：\n` +
        `  变量名: HYB_FARM_COOKIE\n` +
        `  变量值: 从浏览器复制的完整 Cookie 字符串\n\n` +
        `兼容变量: ${COOKIE_ENV_NAMES.slice(1).join(', ')}\n\n` +
        `获取方法：\n` +
        `  1. 登录 https://cdk.hybgzs.com\n` +
        `  2. 打开 https://cdk.hybgzs.com/entertainment/farm\n` +
        `  3. F12 打开开发者工具 -> Network 标签\n` +
        `  4. 刷新页面，点击 farm 相关请求\n` +
        `  5. 复制 Request Headers 中完整 Cookie 值`,
      { type: 'config_error' }
    );
  }

  return {
    accountName: (process.env.HYB_FARM_ACCOUNT || '').trim(),
    baseUrl: normalizeBaseUrl(process.env.HYB_FARM_BASE_URL || DEFAULT_BASE_URL),
    cookie: cookieConfig.cookie,
    cookieEnvName: cookieConfig.envName,
    defaultSeedId: (process.env.HYB_FARM_SEED_ID || '').trim(),
    defaultQuantity: parsePositiveInteger(process.env.HYB_FARM_QUANTITY, null),
    maxPlant: parsePositiveInteger(process.env.HYB_FARM_MAX_PLANT, null),
    plantBodyRaw: (process.env.HYB_FARM_PLANT_BODY || '').trim(),
    timeoutMs: parsePositiveInteger(process.env.HYB_FARM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    autoExecute: parseBoolean(process.env.HYB_FARM_AUTO_EXECUTE, false),
    // 主种：默认锁定杨桃 starfruit，HYB_FARM_SEED_ID 可覆盖
    mainSeedId: (process.env.HYB_FARM_SEED_ID || MAIN_SEED_ID).trim(),
    minEnergy: parseNonNegativeInteger(process.env.HYB_FARM_MIN_ENERGY, DEFAULT_MIN_ENERGY),
    // 卖出/补货开关与保护参数
    autoSell: parseBoolean(process.env.HYB_FARM_AUTO_SELL, true),
    autoBuy: parseBoolean(process.env.HYB_FARM_AUTO_BUY, true),
    sellRatio: parseFloatOrDefault(process.env.HYB_FARM_SELL_RATIO, DEFAULT_SELL_RATIO),
    forceSellUsage: parseFloatOrDefault(process.env.HYB_FARM_FORCE_SELL_USAGE, DEFAULT_FORCE_SELL_USAGE),
    seedReserve: parseNonNegativeInteger(process.env.HYB_FARM_SEED_RESERVE, DEFAULT_SEED_RESERVE),
    maxBuyCost: parsePositiveInteger(process.env.HYB_FARM_MAX_BUY_COST, null),
  };
}

function parseArgs(argv, defaultAction = DEFAULT_ACTION) {
  const args = {
    action: normalizeDefaultAction(defaultAction),
    dryRun: false,
    execute: false,
    help: false,
    maxPlant: null,
    quantity: null,
    seedId: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (FARM_ACTIONS.has(arg)) {
      args.action = arg;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--execute') {
      args.execute = true;
    } else if (arg === '--seed-id') {
      args.seedId = requireNextValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith('--seed-id=')) {
      args.seedId = arg.slice('--seed-id='.length).trim();
    } else if (arg === '--quantity') {
      args.quantity = parsePositiveInteger(requireNextValue(argv, index, arg), null);
      index += 1;
    } else if (arg.startsWith('--quantity=')) {
      args.quantity = parsePositiveInteger(arg.slice('--quantity='.length), null);
    } else if (arg === '--max-plant') {
      args.maxPlant = parsePositiveInteger(requireNextValue(argv, index, arg), null);
      index += 1;
    } else if (arg.startsWith('--max-plant=')) {
      args.maxPlant = parsePositiveInteger(arg.slice('--max-plant='.length), null);
    } else {
      throw new HybFarmError(`未知参数: ${arg}\n使用 --help 查看帮助`, { type: 'config_error' });
    }
  }

  if (args.quantity !== null && args.quantity <= 0) {
    throw new HybFarmError('--quantity 必须是正整数', { type: 'config_error' });
  }
  if (args.maxPlant !== null && args.maxPlant <= 0) {
    throw new HybFarmError('--max-plant 必须是正整数', { type: 'config_error' });
  }

  return args;
}

function requireNextValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new HybFarmError(`${flag} 缺少参数值`, { type: 'config_error' });
  }
  return value.trim();
}

function printUsage() {
  console.log(`使用方法: node hyb-farm.js [动作] [选项]

动作:
  status        查询农场、种子、仓库、体力状态，默认动作，只读
  harvest-all   一键收获成熟作物
  care-all      一键务农，处理浇水/除草/杀虫等护理
  plant-batch   批量种植，默认请求体为 { seedId, quantity }
  auto          自动流程：收获 -> 护理 -> 补货 -> 补种杨桃 -> 卖出盈余

选项:
  --seed-id <id>      种子 ID，例如 golden_apple
  --quantity <n>      种植数量；auto 未设置时使用空地数量
  --max-plant <n>     auto 最大补种数量
  --dry-run           只展示计划，不执行 POST 动作
  --execute           允许 auto 执行 POST；auto 默认 dry-run
  -h, --help          显示此帮助信息

环境变量:
  HYB_FARM_COOKIE        推荐，完整浏览器 Cookie 字符串
  HYB_DASHBOARD_COOKIE   兼容，完整浏览器 Cookie 字符串
  HYBGZS_COOKIE          兼容，完整浏览器 Cookie 字符串
  HYB_COOKIE             兼容，完整浏览器 Cookie 字符串
  HYB_CARDS_COOKIE       兼容，可复用 50 连抽脚本 Cookie
  HYB_FARM_SEED_ID       可选，主种 ID，覆盖默认杨桃 ${MAIN_SEED_ID}
  HYB_FARM_QUANTITY      可选，默认种植数量
  HYB_FARM_MAX_PLANT     可选，auto 最大补种数量
  HYB_FARM_PLANT_BODY    可选，覆盖 plant-batch JSON 请求体
  HYB_FARM_DEFAULT_ACTION 可选，无参数运行时的动作，默认 status
  HYB_FARM_AUTO_EXECUTE  可选，设为 1/true 时允许 auto 默认执行
  HYB_FARM_MIN_ENERGY    可选，护理前保留的体力阈值，默认 ${DEFAULT_MIN_ENERGY}
  HYB_FARM_AUTO_SELL     可选，auto 自动卖出盈余果实，默认开启，设 0 关闭
  HYB_FARM_AUTO_BUY      可选，auto 种子不足时自动补货，默认开启，设 0 关闭
  HYB_FARM_SELL_RATIO    可选，当前价 ≥ 7日均价×该值才卖，默认 ${DEFAULT_SELL_RATIO}
  HYB_FARM_FORCE_SELL_USAGE 可选，仓库使用率 ≥ 该值时无视价格强制卖，默认 ${DEFAULT_FORCE_SELL_USAGE}
  HYB_FARM_SEED_RESERVE  可选，卖出前额外保留的种子数，默认 ${DEFAULT_SEED_RESERVE}
  HYB_FARM_MAX_BUY_COST  可选，单次补货含税总价上限，默认无上限
  HYB_FARM_ACCOUNT       可选，通知中展示的账号备注
  HYB_FARM_BASE_URL      可选，默认为 ${DEFAULT_BASE_URL}
  HYB_FARM_TIMEOUT_MS    可选，请求超时时间（毫秒），默认为 ${DEFAULT_TIMEOUT_MS}

示例:
  node hyb-farm.js status
  node hyb-farm.js plant-batch --seed-id starfruit --quantity 16
  node hyb-farm.js auto --execute

青龙环境变量自动化（任务命令无需追加参数）:
  HYB_FARM_DEFAULT_ACTION=auto    无参数运行时进入自动流程
  HYB_FARM_AUTO_EXECUTE=1        允许真实收获、护理、补货、种植与卖出；不设置时为 dry-run
  （主种默认锁定杨桃 starfruit，如需改种用 HYB_FARM_SEED_ID 覆盖）

青龙定时任务:
  */30 * * * * task 仓库目录/gongyizhan/hyb-farm.js`);
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
  // error 可能是字符串，也可能是对象 {code, message}（实测结构）
  const err = value.error;
  if (err && typeof err === 'object') {
    const nested = String(err.message || err.msg || err.reason || '').trim();
    if (nested) return err.code !== undefined ? `${nested}（code ${err.code}）` : nested;
    if (err.code !== undefined) return `错误码 ${err.code}`;
  }
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
  const refererPath = options.refererPath || FARM_REFERER_PATH;

  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    Cookie: config.cookie,
    DNT: '1',
    Origin: siteOrigin,
    Priority: method === 'GET' ? 'u=1, i' : 'u=0, i',
    Referer: `${siteOrigin}${refererPath}`,
    'Sec-CH-UA': '"Google Chrome";v="150", "Chromium";v="150", "Not;A=Brand";v="8"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"macOS"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
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
          reject(new HybFarmError(message, {
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
          reject(new HybFarmError(message, {
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
      req.destroy(new HybFarmError(`请求超时（${config.timeoutMs}ms）: ${method} ${apiPath}`, {
        type: 'network_error',
      }));
    });

    req.on('error', (error) => {
      reject(error instanceof HybFarmError
        ? error
        : new HybFarmError(`网络请求失败: ${error.message}`, {
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
    throw new HybFarmError(`${context}: ${message}`, {
      type: classifyFailure(200, message, false),
      response: scrubResponse(result),
    });
  }
}

function getData(result) {
  return result?.data && typeof result.data === 'object' ? result.data : result;
}

function getNumber(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function getExplicitArray(value, keys, predicate) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];

  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key];
  }

  const nested = value.data;
  if (Array.isArray(nested)) return nested;
  if (nested && typeof nested === 'object') {
    for (const key of keys) {
      if (Array.isArray(nested[key])) return nested[key];
    }
  }

  return getBestArray(value, predicate);
}

function getSlotCount(value, plantedCount) {
  const candidates = [
    value?.maxSlots,
    value?.data?.maxSlots,
    value?.totalSlots,
    value?.data?.totalSlots,
    value?.baseSlots,
    value?.data?.baseSlots,
  ];
  for (const candidate of candidates) {
    const count = getNumber(candidate, null);
    if (count !== null && count >= plantedCount) return Math.trunc(count);
  }
  return plantedCount;
}

function findArrays(value, predicate, results = []) {
  if (!value || typeof value !== 'object') return results;
  if (Array.isArray(value)) {
    if (value.some(predicate)) results.push(value);
    for (const item of value) findArrays(item, predicate, results);
    return results;
  }
  for (const item of Object.values(value)) findArrays(item, predicate, results);
  return results;
}

function getBestArray(value, predicate) {
  const arrays = findArrays(value, predicate);
  return arrays.sort((left, right) => right.length - left.length)[0] || [];
}

function isPlotLike(item) {
  if (!item || typeof item !== 'object') return false;
  return 'plotId' in item || 'plot_id' in item || 'plotIndex' in item || 'crop' in item || 'plantedAt' in item || 'seedId' in item;
}

function isSeedLike(item) {
  if (!item || typeof item !== 'object') return false;
  return ('seedId' in item || 'id' in item) && ('name' in item || 'displayName' in item || 'price' in item || 'growthTime' in item);
}

function isInventoryLike(item) {
  if (!item || typeof item !== 'object') return false;
  return ('itemId' in item || 'cropId' in item || 'seedId' in item || 'id' in item) && ('quantity' in item || 'count' in item || 'amount' in item);
}

function isEmptyPlot(plot) {
  if (!plot || typeof plot !== 'object') return false;
  const status = String(plot.status || plot.state || '').toLowerCase();
  if (plot.isEmpty === true || plot.empty === true || status === 'empty' || status === 'idle') return true;
  if (plot.crop || plot.cropId || plot.seedId || plot.plantedAt) return false;
  return 'plotId' in plot || 'plot_id' in plot || 'plotIndex' in plot;
}

function isMaturePlot(plot, nowMs = Date.now()) {
  if (!plot || typeof plot !== 'object') return false;
  const status = String(plot.status || plot.state || '').toLowerCase();
  if (
    plot.isMature === true || plot.ready === true || plot.canHarvest === true ||
    status === 'mature' || status === 'ready' || status === 'harvestable' || status.includes('成熟')
  ) {
    return true;
  }

  const maturesAt = plot.maturesAt ?? plot.matureAt ?? plot.harvestAt;
  if (maturesAt === undefined || maturesAt === null || maturesAt === '') return false;
  let timestamp = typeof maturesAt === 'number' ? maturesAt : Date.parse(String(maturesAt));
  if (Number.isFinite(timestamp) && timestamp > 0 && timestamp < 1e12) timestamp *= 1000;
  return Number.isFinite(timestamp) && timestamp <= nowMs;
}

// 实测（2026-07-14 抓包）debuff 以成对时间戳表示：
//   thirstyStartedAt / weedStartedAt / pestStartedAt  —— 缺水/杂草/虫害的发生时刻
//   thirstyHealedAt  / weedHealedAt  / pestHealedAt   —— 对应的治愈时刻
// 「需护理」= 某类 StartedAt 有值，且尚未治愈（HealedAt 为空或早于 StartedAt）。
function hasActiveDebuff(plot, kind) {
  const started = plot[`${kind}StartedAt`];
  if (started === undefined || started === null || started === '') return false;
  const startedMs = Date.parse(String(started));
  const healed = plot[`${kind}HealedAt`];
  if (healed === undefined || healed === null || healed === '') return true;
  const healedMs = Date.parse(String(healed));
  // 治愈时刻早于发生时刻 → 当前这次 debuff 未被治愈，仍需护理
  return Number.isFinite(startedMs) && Number.isFinite(healedMs) && healedMs < startedMs;
}

function isNeedsCarePlot(plot) {
  if (!plot || typeof plot !== 'object') return false;
  if (hasActiveDebuff(plot, 'thirsty') || hasActiveDebuff(plot, 'weed') || hasActiveDebuff(plot, 'pest')) {
    return true;
  }
  // 兜底：conditions 数组或状态文字（结构变动时仍能识别）
  const status = String(plot.status || plot.state || '').toLowerCase();
  return (Array.isArray(plot.conditions) && plot.conditions.length > 0) ||
    plot.needsCare === true || status.includes('water') ||
    status.includes('weed') || status.includes('pest') || status.includes('护理');
}

function isGrowingPlot(plot, nowMs = Date.now()) {
  if (!plot || typeof plot !== 'object') return false;
  if (isEmptyPlot(plot) || isMaturePlot(plot, nowMs)) return false;
  return Boolean(plot.crop || plot.cropId || plot.seedId || plot.plantedAt || plot.growing === true);
}

function getItemId(item) {
  return item?.seedId || item?.cropId || item?.itemId || item?.id || item?.key || 'unknown';
}

function getItemName(item) {
  return item?.name || item?.seedName || item?.cropName || item?.displayName || item?.title || getItemId(item);
}

function getQuantity(item) {
  return getNumber(item?.quantity ?? item?.count ?? item?.amount ?? item?.stock, 0);
}

// 解析仓库容量。返回 { capacity, used, usage(0~1) }，字段缺失时对应值为 null。
function parseWarehouse(state) {
  const inv = state?.inventory;
  if (!inv || typeof inv !== 'object') return { capacity: null, used: null, usage: null };
  // warehouse 可能在顶层，也可能嵌在 data 下
  const wh = inv.warehouse || inv.data?.warehouse || getData(inv)?.warehouse || null;
  if (!wh || typeof wh !== 'object') return { capacity: null, used: null, usage: null };
  const capacity = getNumber(wh.capacity ?? wh.maxCapacity ?? wh.max ?? wh.total, null);
  const used = getNumber(wh.usedCapacity ?? wh.used ?? wh.usage ?? wh.current, null);
  const usage = capacity && capacity > 0 && used !== null ? used / capacity : null;
  return { capacity, used, usage };
}

// 解析真实可补种空地数。
// ⚠️ 实测（2026-07-14）：plots.freeSlots 不是"空闲地块数"，而是"免费档槽位数"
//   （freeSlots 6 / unlockedSlots 8 / vipBonusSlots 2 = totalSlots 16，是槽位分档计数）。
//   真正能补种的地 = unlockedPlotIndexes 里未被 crops.plotIndex 占用的槽位。
// 回退：拿不到 unlockedPlotIndexes 时返回 null，由调用方用 总槽−已占 推算。
function parseFreeSlots(state) {
  const plots = state?.plots;
  if (!plots || plots.unavailable || typeof plots !== 'object') return null;
  const data = getData(plots);
  const unlocked = Array.isArray(data?.unlockedPlotIndexes) ? data.unlockedPlotIndexes : null;
  if (!unlocked || !unlocked.length) return null;

  const cropItems = getExplicitArray(state.crops, ['crops', 'plots'], isPlotLike);
  const occupied = new Set();
  for (const c of cropItems) {
    if (!c || typeof c !== 'object') continue;
    if (!(c.seedId || c.cropId || c.crop || c.plantedAt)) continue; // 只算真种着作物的
    const idx = getNumber(c.plotIndex, null);
    if (idx !== null) occupied.add(Math.trunc(idx));
  }
  const free = unlocked.filter((i) => !occupied.has(Math.trunc(getNumber(i, -1)))).length;
  return Math.max(0, free);
}

// 解析回收价与 7 日均价。返回 Map<seedId, { price, avg7 }>，price/avg7 均为回收口径。
// 实测结构（2026-07-14 抓包核对）：
//   data[]           → 每种作物当前回收价 {seedId, recyclePrice}（无趋势）
//   market.items[]   → 市场价 {seedId, unitPrice, trend:[{avgUnitPrice}...]}（7 日趋势在这）
//   recycleValueMultiplier → 回收价 ≈ 市场价 × 该系数（实测 0.516，近似常数）
// 因回收价与市场价成固定比例，用「市场 7 日均价 × 系数」换算出回收口径的 avg7，
// 与当前回收价比值即可判断是否处于低谷。
function parseRecyclePrices(state) {
  const prices = new Map();
  const raw = state?.recyclePrices;
  if (!raw || raw.unavailable) return prices;
  const multiplier = getNumber(raw?.recycleValueMultiplier, null);

  // 当前回收价：data[] → {seedId, recyclePrice}
  const list = Array.isArray(raw?.data) ? raw.data
    : getExplicitArray(raw, ['prices', 'data'], (item) =>
        item && typeof item === 'object' && ('seedId' in item || 'id' in item));

  // 市场 7 日趋势：market.items[].trend[].avgUnitPrice
  const marketItems = Array.isArray(raw?.market?.items) ? raw.market.items : [];
  const avg7MarketById = new Map();
  for (const m of marketItems) {
    const id = String(m?.seedId || '').trim();
    if (!id) continue;
    const trend = Array.isArray(m?.trend) ? m.trend : [];
    const nums = trend
      .map((t) => getNumber(t?.avgUnitPrice ?? t?.avgPrice ?? t?.price, null))
      .filter((n) => n !== null && n > 0);
    if (nums.length) avg7MarketById.set(id, nums.reduce((a, b) => a + b, 0) / nums.length);
    else {
      // 趋势缺失时退回市场当前价，至少有个参照
      const cur = getNumber(m?.unitPrice, null);
      if (cur !== null && cur > 0) avg7MarketById.set(id, cur);
    }
  }

  for (const item of list) {
    const id = String(item?.seedId || item?.id || '').trim();
    if (!id) continue;
    const price = getNumber(item?.recyclePrice ?? item?.price ?? item?.unitPrice, null);
    // 市场 7 日均价 × 回收系数 → 回收口径的 avg7
    const avg7Market = avg7MarketById.get(id) ?? null;
    let avg7 = null;
    if (avg7Market !== null && multiplier !== null) avg7 = avg7Market * multiplier;
    if (price !== null || avg7 !== null) prices.set(id, { price, avg7 });
  }
  return prices;
}

async function fetchState(config) {
  console.log(`${LOG_PREFIX} 开始查询农场状态`);
  // required：这几个接口失败直接抛错；optional：失败降级不影响主流程
  const endpoints = [
    ['crops', '/api/farm/crops', true],
    ['seeds', '/api/farm/seeds', true],
    ['inventory', '/api/farm/inventory', true],
    ['energy', '/api/farm/energy/status', false],
    ['plots', '/api/farm/plots', false],
    ['recyclePrices', '/api/farm/recycle/prices?includeTrend=1&granularity=day&trendRange=7', false],
  ];
  const state = {};

  for (const [key, apiPath, required] of endpoints) {
    try {
      const result = await requestJson(config, apiPath);
      assertSuccess(result, `获取 ${key} 失败`);
      state[key] = result;
    } catch (error) {
      if (!required) {
        state[key] = { unavailable: true, error: error.message };
        continue;
      }
      throw error;
    }
  }

  return state;
}

function summarizeState(state, nowMs = Date.now()) {
  const cropItems = getExplicitArray(state.crops, ['crops', 'plots'], isPlotLike);
  const plots = cropItems.filter((plot) => !isEmptyPlot(plot));
  const seeds = getExplicitArray(state.seeds, ['seeds'], isSeedLike);
  const inventory = getExplicitArray(state.inventory, ['inventory', 'items'], isInventoryLike);
  // 空地数优先用 /api/farm/plots 的 freeSlots（权威），缺失时回退到 crops 推算
  const authoritativeFree = parseFreeSlots(state);
  const totalSlots = getSlotCount(state.crops, plots.length);
  const emptyByCrops = Math.max(0, totalSlots - plots.length);
  const plotSummary = {
    total: totalSlots,
    mature: plots.filter((plot) => isMaturePlot(plot, nowMs)).length,
    empty: authoritativeFree !== null ? authoritativeFree : emptyByCrops,
    needsCare: plots.filter(isNeedsCarePlot).length,
    growing: plots.filter((plot) => isGrowingPlot(plot, nowMs)).length,
  };

  const seedCatalog = new Map();
  for (const item of seeds) {
    const id = String(item?.id || item?.seedId || getItemId(item));
    if (id && id !== 'unknown') seedCatalog.set(id, item);
  }

  const seedStockById = {};
  for (const item of inventory) {
    if (typeof item?.seedId !== 'string' || !item.seedId.trim()) continue;
    const id = item.seedId.trim();
    seedStockById[id] = (seedStockById[id] || 0) + getQuantity(item);
  }

  const seedSources = seeds.length
    ? seeds
    : inventory.filter((item) => typeof item?.seedId === 'string' && item.seedId.trim());
  const topSeeds = seedSources
    .map((item) => {
      const id = String(item?.id || item?.seedId || getItemId(item));
      return {
        id,
        name: getItemName(seedCatalog.get(id) || item),
        quantity: seedStockById[id] || 0,
      };
    })
    .filter((item) => item.quantity > 0)
    .sort((left, right) => right.quantity - left.quantity)
    .slice(0, 8);
  const topInventory = inventory
    .map((item) => {
      const id = String(getItemId(item));
      const catalogItem = typeof item?.seedId === 'string' ? seedCatalog.get(item.seedId) : null;
      return { id, name: getItemName(catalogItem || item), quantity: getQuantity(item) };
    })
    .filter((item) => item.quantity > 0)
    .sort((left, right) => right.quantity - left.quantity)
    .slice(0, 8);

  let energy = null;
  let energyMax = null;
  let energyError = '';
  if (state.energy?.unavailable) {
    energyError = state.energy.error || '体力接口请求失败';
  } else if (state.energy && typeof state.energy === 'object') {
    const energyData = getData(state.energy);
    energy = getNumber(
      energyData?.currentEnergy ?? energyData?.energy ?? energyData?.current ?? energyData?.value,
      null
    );
    energyMax = getNumber(energyData?.maxEnergy ?? energyData?.maximum ?? energyData?.max, null);
    if (energy === null) energyError = '接口响应缺少 currentEnergy 字段';
  } else {
    energyError = '体力接口没有返回可识别数据';
  }

  return {
    energy,
    energyError,
    energyMax,
    inventory: topInventory,
    plots,
    plotSummary,
    seedStockById,
    seeds: topSeeds,
    warehouse: parseWarehouse(state),
    recyclePrices: parseRecyclePrices(state),
  };
}

function formatItems(items) {
  if (!items.length) return '无可展示库存';
  return items.map((item) => `${item.name}(${item.id}) x${item.quantity}`).join('，');
}

function formatWarehouse(warehouse) {
  if (!warehouse || warehouse.capacity === null || warehouse.used === null) return '容量未知';
  const pct = warehouse.usage === null ? '?' : `${Math.round(warehouse.usage * 100)}%`;
  return `${warehouse.used}/${warehouse.capacity}（${pct}）`;
}

function formatStatus(config, state) {
  const summary = summarizeState(state);
  const energyText = summary.energy === null
    ? `不可用（${summary.energyError || '未知原因'}）`
    : summary.energyMax === null
      ? String(summary.energy)
      : `${summary.energy}/${summary.energyMax}`;
  const lines = [
    `账号: ${config.accountName || '当前账号'}`,
    `地块: 共 ${summary.plotSummary.total}，成熟 ${summary.plotSummary.mature}，空闲 ${summary.plotSummary.empty}，需护理 ${summary.plotSummary.needsCare}，生长中 ${summary.plotSummary.growing}`,
    `体力: ${energyText}`,
    `仓库: ${formatWarehouse(summary.warehouse)}`,
    `可用种子: ${formatItems(summary.seeds)}`,
    `仓库库存: ${formatItems(summary.inventory)}`,
  ];
  return lines.join('\n');
}

function buildPlantBody(config, args, summary = null) {
  if (config.plantBodyRaw) {
    try {
      return JSON.parse(config.plantBodyRaw);
    } catch (error) {
      throw new HybFarmError('环境变量 HYB_FARM_PLANT_BODY 不是合法 JSON', { type: 'config_error' });
    }
  }

  const seedId = (args.seedId || config.defaultSeedId || '').trim();
  if (!seedId) {
    throw new HybFarmError('缺少种子 ID，请设置 --seed-id 或 HYB_FARM_SEED_ID', { type: 'config_error' });
  }

  let quantity = args.quantity ?? config.defaultQuantity ?? null;
  if (quantity === null && summary) quantity = summary.plotSummary.empty;
  if (quantity === null) {
    throw new HybFarmError('缺少种植数量，请设置 --quantity 或 HYB_FARM_QUANTITY', { type: 'config_error' });
  }

  if (summary) quantity = Math.min(quantity, summary.plotSummary.empty);

  const maxPlant = args.maxPlant ?? config.maxPlant ?? null;
  if (maxPlant !== null) quantity = Math.min(quantity, maxPlant);
  if (summary) {
    const available = getNumber(summary.seedStockById?.[seedId], 0);
    if (available <= 0) {
      throw new HybFarmError(`种子 ${seedId} 库存不足，已跳过补种`, { type: 'skipped' });
    }
    quantity = Math.min(quantity, available);
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new HybFarmError('没有可补种的空地或可用种子', { type: 'skipped' });
  }

  return { seedId, quantity };
}

function makeResult(action, type, message, extra = {}) {
  return { action, type, message, ...extra };
}

function getResultIcon(type) {
  if (type === 'success') return '✅';
  if (type === 'skipped') return '⏭️';
  if (type === 'dry_run') return '🧪';
  if (type === 'challenge_required') return '🧩';
  if (type === 'warehouse_full') return '📦';
  if (type === 'vip_required') return '👑';
  return '❌';
}

function isFailureResult(result) {
  return result.type === 'error' || result.type === 'auth_failed' || result.type === 'schema_changed';
}

function resultFromError(action, error) {
  const message = error instanceof HybFarmError ? error.message : String(error);
  if (error instanceof HybFarmError && error.type === 'skipped') {
    return makeResult(action, 'skipped', message);
  }
  if (error instanceof HybFarmError && error.type === 'auth_failed') {
    return makeResult(action, 'auth_failed', `${action}失败: Cookie 已失效或未登录，请更新 Cookie`);
  }
  if (error instanceof HybFarmError && error.type === 'challenge_required') {
    return makeResult(action, 'challenge_required', `${action}需要 CAP/Cloudflare 验证，脚本已跳过`);
  }
  if (error instanceof HybFarmError && error.type === 'schema_changed') {
    return makeResult(action, 'schema_changed', `${action}失败: 接口结构变化或返回非预期内容`);
  }
  return makeResult(action, 'error', `${action}失败: ${message}`);
}

function formatResult(result) {
  if (isFailureResult(result)) {
    return `${getResultIcon(result.type)} 发生异常：${result.action}: ${result.message}`;
  }
  return `${getResultIcon(result.type)} ${result.action}: ${result.message}`;
}

function summarizeActionData(data) {
  const message = getMessage(data);
  const count = data?.count ?? data?.quantity ?? data?.harvested ?? data?.planted ?? data?.affected;
  const lines = [];
  if (message) lines.push(message);
  if (count !== undefined) lines.push(`数量: ${count}`);
  return lines.length ? lines.join('，') : '操作成功';
}

async function postAction(config, action, apiPath, body = {}) {
  try {
    const result = await requestJson(config, apiPath, {
      method: 'POST',
      body,
    });
    assertSuccess(result, `${action}失败`);
    return makeResult(action, 'success', summarizeActionData(getData(result)), { data: getData(result) });
  } catch (error) {
    return resultFromError(action, error);
  }
}

async function performHarvestAll(config, dryRun = false) {
  const action = '一键收获';
  // destroyIfFull=false：仓满时不销毁多余作物，宁可停下也不丢东西，改由通知提醒去卖
  if (dryRun) return makeResult(action, 'dry_run', 'dry-run，未执行 POST /api/farm/harvest-all');
  try {
    const result = await requestJson(config, '/api/farm/harvest-all', {
      method: 'POST',
      body: { destroyIfFull: false },
    });
    // 仓满可能以 success:false 形式返回，先判仓满再断言
    if (isWarehouseFull(result)) {
      return makeResult(action, 'warehouse_full', '仓库已满，部分作物未能收获，请尽快去卖出腾空间');
    }
    assertSuccess(result, `${action}失败`);
    const data = getData(result);
    const destroyed = getNumber(data?.destroyedCount, 0);
    const base = makeResult(action, 'success', summarizeActionData(data), { data });
    if (destroyed > 0) base.message += `（销毁 ${destroyed}）`;
    return base;
  } catch (error) {
    // 仓满也可能以 HTTP 错误 / 抛异常形式出现
    if (error instanceof HybFarmError && isWarehouseFull(error.details?.response || error.details)) {
      return makeResult(action, 'warehouse_full', '仓库已满，部分作物未能收获，请尽快去卖出腾空间');
    }
    return resultFromError(action, error);
  }
}

async function performCareAll(config, dryRun = false) {
  if (dryRun) return makeResult('一键务农', 'dry_run', 'dry-run，未执行 POST /api/farm/care/all');
  return postAction(config, '一键务农', '/api/farm/care/all', {});
}

async function performPlantBatch(config, body, dryRun = false) {
  const action = '批量种植';
  const label = `批量种植 ${body.seedId || 'custom'} x${body.quantity || '?'}`;
  if (dryRun) return makeResult(action, 'dry_run', `dry-run，计划 ${label}`);
  const result = await postAction(config, action, '/api/farm/plant-batch', body);
  // VIP 专属作物在 VIP 失效时种植失败 → 标成 vip_required 以便单独发通知提醒续费
  if (isFailureResult(result) && isVipMessage(result.message)) {
    return makeResult(action, 'vip_required', `种植 ${body.seedId} 失败，疑似 VIP 已过期：${result.message}`);
  }
  return result;
}

// 从 seeds 目录用 名字/ID 双匹配定位主种（杨桃 starfruit）。返回 { seedId, seed } 或 null。
function resolveMainSeed(config, state) {
  const seeds = getExplicitArray(state.seeds, ['seeds'], isSeedLike);
  const wanted = String(config.mainSeedId || '').trim().toLowerCase();
  // 别名（starfruit/杨桃）只在目标确为默认主种时启用；用户覆盖 HYB_FARM_SEED_ID 后只按其精确匹配
  const useAliases = wanted === MAIN_SEED_ID.toLowerCase();
  const aliases = useAliases ? MAIN_SEED_ALIASES.map((a) => a.toLowerCase()) : [];
  const matches = (v) => {
    const s = String(v || '').trim().toLowerCase();
    return s !== '' && (s === wanted || aliases.includes(s));
  };
  for (const seed of seeds) {
    if (matches(seed?.id) || matches(seed?.seedId) || matches(seed?.name)) {
      return { seedId: String(seed.id || seed.seedId).trim(), seed };
    }
  }
  return null;
}

// VIP 专属作物在 VIP 失效时种植会失败，识别这类消息以便单独发通知提醒续费。
function isVipMessage(message) {
  const text = String(message || '').toLowerCase();
  return text.includes('vip') || text.includes('会员') || text.includes('特权') ||
    text.includes('权限不足') || text.includes('专属');
}

// 仓满错误码 WAREHOUSE_FULL（藏在 error.data.error.code 或消息里）。
function isWarehouseFull(result) {
  const code = String(
    result?.data?.error?.code || result?.error?.code || result?.code || ''
  ).toUpperCase();
  if (code === 'WAREHOUSE_FULL') return true;
  const text = String(getMessage(result)).toLowerCase();
  return text.includes('warehouse_full') || text.includes('仓库已满') || text.includes('仓库满');
}

// 决定是否卖出：force（仓将满）无视价格；否则要求当前价 ≥ 7 日均价 × sellRatio（躲低谷）。
function shouldSell(config, warehouse, priceInfo) {
  const force = warehouse?.usage !== null && warehouse?.usage !== undefined &&
    warehouse.usage >= config.forceSellUsage;
  if (force) return { sell: true, force: true, reason: `仓库使用率 ${(warehouse.usage * 100).toFixed(0)}% ≥ ${(config.forceSellUsage * 100).toFixed(0)}%，强制卖出` };
  const price = priceInfo?.price ?? null;
  const avg7 = priceInfo?.avg7 ?? null;
  // 没有均价参照就默认卖（实测回收价几乎不波动，等高价无意义）
  if (avg7 === null || price === null) return { sell: true, force: false, reason: '无 7 日均价参照，按稳定价卖出' };
  if (price >= avg7 * config.sellRatio) {
    return { sell: true, force: false, reason: `当前价 ${price} ≥ 均价 ${avg7.toFixed(0)}×${config.sellRatio}` };
  }
  return { sell: false, force: false, reason: `当前价 ${price} < 均价 ${avg7.toFixed(0)}×${config.sellRatio}，低谷跳过` };
}

// 卖出主种的果实盈余（两步：quote 拿即时价 → recycle 带滑点保护）。
// 前置：本轮补种已完成，seedStockById 反映补种后剩余，因此卖的都是纯盈余果实，不会误卖种子。
async function runSell(config, seedId, summary, dryRun = false) {
  const action = '交易所卖出';
  if (!config.autoSell) return makeResult(action, 'skipped', '未开启自动卖出（HYB_FARM_AUTO_SELL=0）');
  const stock = getNumber(summary.seedStockById?.[seedId], 0);
  const sellable = stock - config.seedReserve;
  if (sellable <= 0) {
    return makeResult(action, 'skipped', `${seedId} 盈余不足（库存 ${stock}，保留 ${config.seedReserve}）`);
  }

  const priceInfo = summary.recyclePrices?.get(seedId) || null;
  const decision = shouldSell(config, summary.warehouse, priceInfo);
  if (!decision.sell) return makeResult(action, 'skipped', decision.reason);

  if (dryRun) {
    return makeResult(action, 'dry_run', `dry-run，计划卖出 ${seedId} x${sellable}（${decision.reason}）`);
  }

  try {
    const quote = await requestJson(config, '/api/farm/recycle/quote', {
      method: 'POST',
      body: { seedId, quantity: sellable },
    });
    assertSuccess(quote, '获取回收报价失败');
    const quoteData = getData(quote);
    const unitPrice = getNumber(quoteData?.unitPrice ?? quoteData?.price ?? quoteData?.expectedUnitPrice, null);
    if (unitPrice === null) {
      return makeResult(action, 'error', '回收报价缺少 unitPrice 字段，已跳过卖出');
    }
    const result = await requestJson(config, '/api/farm/recycle', {
      method: 'POST',
      body: { seedId, quantity: sellable, expectedUnitPrice: unitPrice, maxSlippageBps: MAX_SLIPPAGE_BPS },
    });
    assertSuccess(result, '回收卖出失败');
    const data = getData(result);
    const gained = getNumber(data?.totalQuota ?? data?.total ?? data?.gained, null);
    const msg = `卖出 ${seedId} x${sellable} @${unitPrice}${gained !== null ? `，获得 ${gained}` : ''}（${decision.reason}）`;
    return makeResult(action, 'success', msg, { data });
  } catch (error) {
    return resultFromError(action, error);
  }
}

// 从菜场买最低价挂单补足种子（两步：market 列表挑最低价 → quote 校验含税总价 → purchase）。
async function runBuy(config, seedId, needed, dryRun = false) {
  const action = '菜场补货';
  if (!config.autoBuy) return makeResult(action, 'skipped', '未开启自动补货（HYB_FARM_AUTO_BUY=0）');
  if (needed <= 0) return makeResult(action, 'skipped', '库存充足，无需补货');

  try {
    const market = await requestJson(config, `/api/farm/market?seedId=${encodeURIComponent(seedId)}&page=1&limit=20`);
    assertSuccess(market, '获取菜场挂单失败');
    const listings = getExplicitArray(market, ['listings', 'data'], (i) =>
      i && typeof i === 'object' && ('pricePerUnit' in i || 'price' in i));
    const valid = listings
      .map((l) => ({
        listingId: l?.id || l?.listingId,
        pricePerUnit: getNumber(l?.pricePerUnit ?? l?.price, null),
        quantity: getNumber(l?.quantity ?? l?.amount, 0),
      }))
      .filter((l) => l.listingId && l.pricePerUnit !== null && l.quantity > 0)
      .sort((a, b) => a.pricePerUnit - b.pricePerUnit);
    if (!valid.length) return makeResult(action, 'skipped', `菜场无 ${seedId} 可买挂单`);

    const best = valid[0];
    const buyQty = Math.min(needed, best.quantity);
    if (dryRun) {
      return makeResult(action, 'dry_run', `dry-run，计划买 ${seedId} x${buyQty} @${best.pricePerUnit}`);
    }

    const quote = await requestJson(config, '/api/farm/market/quote', {
      method: 'POST',
      body: { listingId: best.listingId, quantity: buyQty },
    });
    assertSuccess(quote, '获取菜场报价失败');
    const quoteData = getData(quote);
    const total = getNumber(quoteData?.buyerPaysTotal ?? quoteData?.total ?? quoteData?.totalCost, null);
    if (config.maxBuyCost !== null && total !== null && total > config.maxBuyCost) {
      return makeResult(action, 'skipped', `含税总价 ${total} 超过上限 ${config.maxBuyCost}，已跳过补货`);
    }

    const result = await requestJson(config, '/api/farm/market/purchase', {
      method: 'POST',
      body: { listingId: best.listingId, quantity: buyQty },
    });
    assertSuccess(result, '菜场购买失败');
    const tax = getNumber(quoteData?.taxAmount, null);
    const msg = `买入 ${seedId} x${buyQty} @${best.pricePerUnit}${total !== null ? `，含税总价 ${total}` : ''}${tax !== null ? `（税 ${tax}）` : ''}`;
    return makeResult(action, 'success', msg, { data: getData(result), boughtQty: buyQty });
  } catch (error) {
    return resultFromError(action, error);
  }
}

async function runAuto(config, args) {
  const shouldExecute = args.execute || config.autoExecute;
  const dryRun = args.dryRun || !shouldExecute;
  const initialState = await fetchState(config);
  const initialSummary = summarizeState(initialState);
  const results = [];
  let harvestResult = null;

  // 1. 收获成熟作物（destroyIfFull=false，仓满走单独通知）
  if (initialSummary.plotSummary.mature > 0) {
    harvestResult = await performHarvestAll(config, dryRun);
    results.push(harvestResult);
  } else {
    results.push(makeResult('一键收获', 'skipped', '没有成熟作物'));
  }

  // 2. 护理：需护理 + 体力充足才做（体力不足留给别的用途）
  if (initialSummary.plotSummary.needsCare > 0) {
    const energy = initialSummary.energy;
    if (energy !== null && energy < config.minEnergy) {
      results.push(makeResult('一键务农', 'skipped', `体力 ${energy} 低于阈值 ${config.minEnergy}，跳过护理`));
    } else {
      results.push(await performCareAll(config, dryRun));
    }
  } else {
    results.push(makeResult('一键务农', 'skipped', '没有需要护理的地块'));
  }

  // 收获后刷新一次状态，拿到最新空地与库存
  const shouldRefreshAfterHarvest = !dryRun && harvestResult?.type === 'success';
  let workState = shouldRefreshAfterHarvest ? await fetchState(config) : initialState;
  let workSummary = summarizeState(workState);

  // 3. 定位主种（杨桃）。定位不到就回退到 config.mainSeedId 原样使用
  const resolved = resolveMainSeed(config, workState);
  const seedId = resolved ? resolved.seedId : config.mainSeedId;

  // 4. 补种前先补货：空地数 > 主种库存时，去菜场买最低价补足
  const empty = workSummary.plotSummary.empty;
  if (empty > 0) {
    const stock = getNumber(workSummary.seedStockById?.[seedId], 0);
    const shortfall = empty - stock;
    if (shortfall > 0) {
      const buyResult = await runBuy(config, seedId, shortfall, dryRun);
      results.push(buyResult);
      // 买成功后刷新库存，让后续补种能用上新买的种子
      if (!dryRun && buyResult.type === 'success') {
        workState = await fetchState(config);
        workSummary = summarizeState(workState);
      }
    }
  }

  // 5. 补种主种到空地
  if (workSummary.plotSummary.empty > 0) {
    try {
      const body = buildPlantBody(config, { ...args, seedId }, workSummary);
      if (body.quantity > 0) {
        results.push(await performPlantBatch(config, body, dryRun));
      } else {
        results.push(makeResult('批量种植', 'skipped', '没有可补种的空地或种子'));
      }
    } catch (error) {
      results.push(resultFromError('批量种植', error));
    }
  } else {
    results.push(makeResult('批量种植', 'skipped', '没有空闲地块'));
  }

  // 6. 卖出盈余：仅在本轮真收获了果实时才卖。
  //    关键安全前提——种子与果实同池，库存无法区分二者。只有本轮收获成功，
  //    才能确定库存里新增的是果实；否则（没成熟/没收获）库存里全是种子，绝不能卖。
  //    补种在收获后进行，会先消耗掉种子，故收获后刷新的库存即纯果实盈余。
  const harvestSucceeded = !dryRun && harvestResult?.type === 'success';
  let finalState = workState;
  if (harvestSucceeded) {
    // 补种可能又消耗了库存，卖出前用最新状态
    const plantSucceeded = results.some((r) => r.action === '批量种植' && r.type === 'success');
    const sellState = plantSucceeded ? await fetchState(config) : workState;
    const sellSummary = plantSucceeded ? summarizeState(sellState) : workSummary;
    results.push(await runSell(config, seedId, sellSummary, dryRun));
    finalState = sellState;
  } else if (dryRun && config.autoSell) {
    // dry-run 时给个提示，说明真实运行的卖出取决于是否收获
    results.push(makeResult('交易所卖出', 'skipped', '本轮未收获果实，跳过卖出（种子/果实同池，避免误卖种子）'));
  } else {
    results.push(makeResult('交易所卖出', 'skipped', '本轮未收获果实，跳过卖出'));
  }

  return { dryRun, results, state: finalState };
}

function formatSummary(config, state, results = [], statusOnly = false) {
  const hasState = Boolean(state && Object.keys(state).length > 0);
  const lines = [statusOnly ? '📊 状态查询' : '📋 执行汇总'];

  if (hasState) {
    lines.push('', formatStatus(config, state));
  }

  if (!statusOnly) {
    lines.push('', '执行结果:');
    for (const result of results) lines.push(formatResult(result));
  }

  return lines.join('\n');
}

async function run() {
  loadDotEnv();
  const defaultAction = normalizeDefaultAction(process.env.HYB_FARM_DEFAULT_ACTION || DEFAULT_ACTION);
  const args = parseArgs(process.argv.slice(2), defaultAction);
  if (args.help) {
    printUsage();
    return;
  }

  const config = getConfig();
  console.log(`${LOG_PREFIX} 开始执行 ${args.action} - ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  console.log(`${LOG_PREFIX} 使用 Cookie 变量: ${config.cookieEnvName}`);

  if (args.action === 'status') {
    const state = await fetchState(config);
    const text = formatSummary(config, state, [], true);
    console.log(text);
    await sendQinglongNotification(TASK_NAME, text);
    return;
  }

  if (args.action === 'plant-batch') {
    const body = buildPlantBody(config, args);
    const result = await performPlantBatch(config, body, args.dryRun);
    console.log(`${LOG_PREFIX} ${formatResult(result)}`);
    await sendQinglongNotification(TASK_NAME, formatSummary(config, {}, [result]));
    if (isFailureResult(result)) process.exitCode = 1;
    return;
  }

  if (args.action === 'harvest-all') {
    const result = await performHarvestAll(config, args.dryRun);
    console.log(`${LOG_PREFIX} ${formatResult(result)}`);
    await sendQinglongNotification(TASK_NAME, formatSummary(config, {}, [result]));
    if (isFailureResult(result)) process.exitCode = 1;
    return;
  }

  if (args.action === 'care-all') {
    const result = await performCareAll(config, args.dryRun);
    console.log(`${LOG_PREFIX} ${formatResult(result)}`);
    await sendQinglongNotification(TASK_NAME, formatSummary(config, {}, [result]));
    if (isFailureResult(result)) process.exitCode = 1;
    return;
  }

  const autoResult = await runAuto(config, args);
  if (autoResult.dryRun) {
    console.log(`${LOG_PREFIX} auto 当前为 dry-run；需要真实执行请加 --execute 或设置 HYB_FARM_AUTO_EXECUTE=1`);
  }
  for (const result of autoResult.results) {
    console.log(`${LOG_PREFIX} ${formatResult(result)}`);
  }

  // 仓满 / VIP失效或种植失败 —— 单独各发一条（仿 f799c2b 签到失败分离发送）
  const warehouseFull = autoResult.results.filter((r) => r.type === 'warehouse_full');
  const vipIssues = autoResult.results.filter((r) => r.type === 'vip_required');
  if (warehouseFull.length > 0) {
    await sendQinglongNotification(
      `${TASK_NAME} · 仓库已满`,
      `📦 仓库已满，作物未能全部收获\n\n${warehouseFull.map(formatResult).join('\n')}\n\n请尽快去交易所卖出腾空间。`
    );
  }
  if (vipIssues.length > 0) {
    await sendQinglongNotification(
      `${TASK_NAME} · VIP 失效`,
      `👑 主种为 VIP 专属作物，种植失败，疑似 VIP 已过期\n\n${vipIssues.map(formatResult).join('\n')}\n\n请续费 VIP 或用 HYB_FARM_SEED_ID 改种非 VIP 作物。`
    );
  }

  await sendQinglongNotification(TASK_NAME, formatSummary(config, autoResult.state, autoResult.results));
  if (autoResult.results.some(isFailureResult)) process.exitCode = 1;
}

if (require.main === module) {
  run().catch((error) => {
    const errorMsg = error instanceof HybFarmError && error.type === 'auth_failed'
      ? 'Cookie 已失效或未登录，请更新 HYB_FARM_COOKIE'
      : error instanceof HybFarmError && error.type === 'challenge_required'
        ? '站点要求 CAP/Cloudflare 验证，请在浏览器完成验证后重试'
        : error instanceof HybFarmError
          ? error.message
          : `未知错误: ${error.message || String(error)}`;

    console.error(`${LOG_PREFIX} 执行失败: ${errorMsg}`);
    if (error instanceof HybFarmError && error.details && Object.keys(error.details).length > 0) {
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
  HybFarmError,
  buildPlantBody,
  classifyFailure,
  fetchState,
  formatStatus,
  formatSummary,
  getConfig,
  normalizeBaseUrl,
  normalizeCookie,
  normalizeDefaultAction,
  parseArgs,
  parseWarehouse,
  parseFreeSlots,
  parseRecyclePrices,
  performCareAll,
  performHarvestAll,
  performPlantBatch,
  requestJson,
  resolveMainSeed,
  run,
  runAuto,
  runBuy,
  runSell,
  scrubBody,
  scrubResponse,
  sendQinglongNotification,
  shouldSell,
  summarizeState,
};
