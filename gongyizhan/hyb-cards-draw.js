#!/usr/bin/env node
// cron: 30 8 * * *
// new Env('黑与白福利站 50连抽');
// description: 黑与白福利站每日自动 50 连抽，默认只使用免费次数

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const DEFAULT_BASE_URL = 'https://cdk.hybgzs.com';
const DEFAULT_TIMEOUT_MS = 30000;
const DRAW_COUNT = 50;
const DRAW_TYPE = 'fifty';
const TASK_NAME = '黑与白福利站 50连抽';

class HybCardsError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'HybCardsError';
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

  const cookie = normalizeCookie(
    process.env.HYB_CARDS_COOKIE ||
    process.env.HYBGZS_COOKIE ||
    process.env.HYB_COOKIE ||
    ''
  );

  if (!cookie) {
    throw new HybCardsError(
      '缺少环境变量 HYB_CARDS_COOKIE\n' +
      '请在青龙面板"环境变量"中添加：\n' +
      '  变量名: HYB_CARDS_COOKIE\n' +
      '  变量值: 从浏览器复制的完整 Cookie 字符串\n\n' +
      '获取方法：\n' +
      '  1. 登录 https://cdk.hybgzs.com\n' +
      '  2. 打开 https://cdk.hybgzs.com/entertainment/cards/draw\n' +
      '  3. F12 打开开发者工具 → Network 标签\n' +
      '  4. 刷新页面，点击 draw/status 或 draw 请求\n' +
      '  5. 复制 Request Headers 中的 Cookie 值'
    );
  }

  const baseUrl = normalizeBaseUrl(process.env.HYB_CARDS_BASE_URL || DEFAULT_BASE_URL);
  const timeoutMs = parsePositiveInteger(process.env.HYB_CARDS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const allowPaid = parseBoolean(process.env.HYB_CARDS_ALLOW_PAID);
  const accountName = (process.env.HYB_CARDS_ACCOUNT || '').trim();

  return { accountName, allowPaid, baseUrl, cookie, timeoutMs };
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
      throw new HybCardsError(`未知参数: ${arg}\n使用 --help 查看帮助`);
    }
  }

  return args;
}

function printUsage() {
  console.log(`使用方法: node hyb-cards-draw.js [选项]

选项:
  --status-only   仅查询今日抽卡状态，不执行抽卡
  -h, --help      显示此帮助信息

环境变量:
  HYB_CARDS_COOKIE       必需，从浏览器复制的完整 Cookie 字符串
  HYB_CARDS_ALLOW_PAID   可选，设为 1/true 时允许免费不足 50 次时用付费额度补足，默认不允许
  HYB_CARDS_ACCOUNT      可选，通知中展示的账号备注
  HYB_CARDS_BASE_URL     可选，默认为 ${DEFAULT_BASE_URL}
  HYB_CARDS_TIMEOUT_MS   可选，请求超时时间（毫秒），默认为 ${DEFAULT_TIMEOUT_MS}

青龙定时任务:
  30 8 * * * node /ql/data/scripts/hyb-cards-draw.js`);
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

      if (sendNotify) {
        return { sendNotify, file };
      }
    } catch (error) {
      console.error(`[hybgzs] 加载青龙通知模块失败: ${file}`);
      console.error(`[hybgzs] 错误: ${error.message}`);
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
    console.error(`[hybgzs] 青龙通知发送失败: ${error.message}`);
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
    throw new HybCardsError(`环境变量 HYB_CARDS_BASE_URL 格式无效: ${raw}\n请提供完整的 URL（如 ${DEFAULT_BASE_URL}）`);
  }
}

function parsePositiveInteger(raw, fallback) {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
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

function parseBoolean(raw) {
  if (!raw) return false;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(raw).trim().toLowerCase());
}

function requestJson(config, apiPath, options = {}) {
  const method = options.method || 'GET';
  const body = options.body === undefined ? null : String(options.body);
  const url = new URL(apiPath, config.baseUrl);
  const siteOrigin = new URL(config.baseUrl).origin;
  const client = url.protocol === 'http:' ? http : https;

  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    Cookie: config.cookie,
    DNT: '1',
    Origin: siteOrigin,
    Priority: 'u=1, i',
    Referer: `${siteOrigin}/entertainment/cards/draw`,
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
        const looksLikeHtml = /^<!doctype html/i.test(trimmedBody) || /^<html/i.test(trimmedBody);

        let parsed = null;
        if (trimmedBody && !looksLikeHtml) {
          try {
            parsed = JSON.parse(trimmedBody);
          } catch (error) {
            parsed = null;
          }
        }

        if (statusCode < 200 || statusCode >= 300) {
          const apiMessage = parsed && (parsed.error || parsed.message);
          const message = apiMessage || (
            looksLikeHtml
              ? `服务器返回 HTML，可能触发 Cloudflare/频率限制（HTTP ${statusCode}）`
              : `HTTP ${statusCode} - ${method} ${apiPath}`
          );
          reject(new HybCardsError(message, {
            statusCode,
            contentType,
            body: scrubBody(responseBody),
          }));
          return;
        }

        if (!parsed) {
          reject(new HybCardsError(
            looksLikeHtml
              ? '服务器返回 HTML，Cookie 可能失效或被 Cloudflare 拦截'
              : '服务器返回了非 JSON 格式的响应',
            { statusCode, contentType, body: scrubBody(responseBody) }
          ));
          return;
        }

        resolve(parsed);
      });
    });

    req.setTimeout(config.timeoutMs, () => {
      req.destroy(new HybCardsError(`请求超时（${config.timeoutMs}ms）: ${method} ${apiPath}`));
    });

    req.on('error', (error) => {
      reject(error instanceof HybCardsError
        ? error
        : new HybCardsError(`网络请求失败: ${error.message}`, { originalError: error.message }));
    });

    if (body !== null) {
      req.write(body);
    }
    req.end();
  });
}

function scrubBody(body) {
  if (!body) return '';
  return String(body)
    .replace(/(__Secure-authjs\.session-token=)[^;\s<]+/g, '$1[redacted]')
    .replace(/(cf_clearance=)[^;\s<]+/g, '$1[redacted]')
    .slice(0, 500);
}

function assertSuccess(result, context) {
  if (!result || result.success !== true) {
    const message = result && (result.error || result.message)
      ? `${context}: ${result.error || result.message}`
      : `${context}: 未知错误`;
    throw new HybCardsError(message, { response: scrubResponse(result) });
  }
}

function scrubResponse(value) {
  if (!value || typeof value !== 'object') return value;
  const clone = Array.isArray(value) ? [...value] : { ...value };
  delete clone.cookie;
  delete clone.token;
  delete clone.access_token;
  delete clone.refresh_token;
  return clone;
}

function getNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function quotaToCurrency(quota) {
  const value = getNumber(quota, 0) / 500000;
  return `$${value.toFixed(2)}`;
}

function getSeasonName(status) {
  return status?.season?.name || status?.season?.title || status?.seasonName || '未知赛季';
}

function getAccountLabel(config, status) {
  return config.accountName ||
    status?.user?.name ||
    status?.user?.username ||
    status?.username ||
    '当前账号';
}

function getEligibility(status, config) {
  const limits = status?.limits || {};
  const vip = status?.vip || {};
  const pricing = status?.pricing || {};
  const freeRemaining = getNumber(limits.freeRemaining, 0);
  const dailyFreeLimit = getNumber(limits.dailyFreeLimit, 0);
  const dailyPaidLimit = getNumber(limits.dailyPaidLimit, 0);
  const totalUsed = getNumber(limits.totalUsed, 0);
  const totalLimit = dailyFreeLimit + dailyPaidLimit;

  if (!vip.isVip) {
    return {
      canDraw: false,
      reason: '50连抽为 VIP 专属功能，当前账号不是 VIP',
    };
  }

  if (limits.freeDrawBlocked) {
    return {
      canDraw: false,
      reason: '当前账号触发互助基金惩罚，无法使用每日免费抽卡',
    };
  }

  if (totalLimit > 0 && totalUsed + DRAW_COUNT > totalLimit) {
    return {
      canDraw: false,
      reason: `今日抽卡上限不足：已用 ${totalUsed}/${totalLimit}`,
    };
  }

  if (!config.allowPaid && freeRemaining < DRAW_COUNT) {
    return {
      canDraw: false,
      reason: `免费次数不足：剩余 ${freeRemaining}/${DRAW_COUNT}，未开启 HYB_CARDS_ALLOW_PAID`,
    };
  }

  const freeUsed = Math.min(DRAW_COUNT, freeRemaining);
  const paidUsed = DRAW_COUNT - freeUsed;
  const singleDrawPrice = getNumber(pricing.singleDrawPrice, 0);
  const cost = paidUsed * singleDrawPrice;
  const userQuota = getNumber(status.userQuota, 0);

  if (paidUsed > 0 && cost > userQuota) {
    return {
      canDraw: false,
      reason: `余额不足：需要 ${quotaToCurrency(cost)}，当前 ${quotaToCurrency(userQuota)}`,
    };
  }

  return {
    canDraw: true,
    freeUsed,
    paidUsed,
    cost,
  };
}

function describeStatus(config, status) {
  const limits = status?.limits || {};
  const vip = status?.vip || {};
  const pricing = status?.pricing || {};
  const totalLimit = getNumber(limits.dailyFreeLimit, 0) + getNumber(limits.dailyPaidLimit, 0);
  const lines = [
    `账号: ${getAccountLabel(config, status)}`,
    `赛季: ${getSeasonName(status)}`,
    `VIP: ${vip.isVip ? '是' : '否'}`,
    `免费剩余: ${getNumber(limits.freeRemaining, 0)}`,
    `付费已用: ${getNumber(limits.paidUsed, 0)}/${getNumber(limits.dailyPaidLimit, 0)}`,
    `今日总计: ${getNumber(limits.totalUsed, 0)}/${totalLimit}`,
    `单抽价格: ${quotaToCurrency(pricing.singleDrawPrice)}`,
    `账号余额: ${quotaToCurrency(status?.userQuota)}`,
  ];

  if (limits.resetAt) {
    lines.push(`重置时间: ${limits.resetAt}`);
  }

  return lines.join('\n');
}

function summarizeCards(cards) {
  if (!Array.isArray(cards) || cards.length === 0) {
    return '未返回卡牌明细';
  }

  const rarityCounts = new Map();
  const specialCards = [];

  for (const item of cards) {
    const card = item?.card && typeof item.card === 'object' ? item.card : item;
    const rarity = card?.rarity || item?.rarity || 'unknown';
    rarityCounts.set(rarity, (rarityCounts.get(rarity) || 0) + 1);

    const isSpecial = Boolean(card?.isSP || item?.isSP || card?.sp || item?.sp);
    if (isSpecial || ['ssr', 'sp', 'legendary', 'mythic', '史诗卡', '传说卡'].includes(String(rarity).toLowerCase())) {
      specialCards.push(card?.name || card?.title || item?.name || item?.title || `${rarity} 卡牌`);
    }
  }

  const raritySummary = Array.from(rarityCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([rarity, count]) => `${rarity} x${count}`)
    .join(', ');

  const lines = [
    `共获得 ${cards.length} 张卡牌`,
    `稀有度统计: ${raritySummary || '无'}`,
  ];

  if (specialCards.length > 0) {
    lines.push(`高价值卡牌: ${specialCards.slice(0, 8).join(', ')}${specialCards.length > 8 ? ' 等' : ''}`);
  }

  return lines.join('\n');
}

function summarizeAchievements(achievements) {
  if (!Array.isArray(achievements) || achievements.length === 0) return '';
  const names = achievements
    .map((item) => item?.name || item?.title || item?.achievement?.name || item?.achievement?.title)
    .filter(Boolean);
  return names.length > 0
    ? `\n新成就: ${names.join(', ')}`
    : `\n新成就数量: ${achievements.length}`;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const config = getConfig();
  console.log(`[hybgzs] 开始检查抽卡状态 - ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);

  let status;
  try {
    status = await requestJson(config, '/api/cards/draw/status');
    assertSuccess(status, '获取抽卡状态失败');
  } catch (error) {
    const errorMsg = error instanceof HybCardsError ? error.message : String(error);
    console.error(`[hybgzs] 获取抽卡状态失败: ${errorMsg}`);
    await sendQinglongNotification(TASK_NAME, `❌ 发生异常：获取抽卡状态失败\n\n${errorMsg}\n\n请检查 HYB_CARDS_COOKIE 是否已失效或无效`);
    error.notificationSent = true;
    throw error;
  }

  const accountLabel = getAccountLabel(config, status);
  console.log(`[hybgzs] 状态获取成功: ${accountLabel}`);
  console.log(describeStatus(config, status));

  if (args.statusOnly) {
    await sendQinglongNotification(TASK_NAME, `📊 状态查询\n\n${describeStatus(config, status)}`);
    return;
  }

  const eligibility = getEligibility(status, config);
  if (!eligibility.canDraw) {
    console.log(`[hybgzs] 跳过抽卡: ${eligibility.reason}`);
    await sendQinglongNotification(
      TASK_NAME,
      `账号: ${accountLabel}\n⏭️ 跳过抽卡\n\n${eligibility.reason}\n\n${describeStatus(config, status)}`
    );
    return;
  }

  console.log(`[hybgzs] 开始 50 连抽，免费 ${eligibility.freeUsed} 次，付费 ${eligibility.paidUsed} 次`);
  if (eligibility.paidUsed > 0) {
    console.log(`[hybgzs] 本次预计消耗: ${quotaToCurrency(eligibility.cost)}`);
  }

  let drawResult;
  try {
    drawResult = await requestJson(config, '/api/cards/draw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: DRAW_TYPE }),
    });
    assertSuccess(drawResult, '50连抽失败');
  } catch (error) {
    const errorMsg = error instanceof HybCardsError ? error.message : String(error);
    console.error(`[hybgzs] 50连抽失败: ${errorMsg}`);
    await sendQinglongNotification(TASK_NAME, `账号: ${accountLabel}\n❌ 发生异常：50连抽失败\n\n${errorMsg}`);
    error.notificationSent = true;
    throw error;
  }

  const cardSummary = summarizeCards(drawResult.cards);
  const achievementSummary = summarizeAchievements(drawResult.grantedAchievements);
  const paidSummary = eligibility.paidUsed > 0
    ? `\n付费次数: ${eligibility.paidUsed}\n消耗额度: ${quotaToCurrency(eligibility.cost)}`
    : '';

  console.log('[hybgzs] 50连抽成功');
  console.log(cardSummary);

  await sendQinglongNotification(
    TASK_NAME,
    `账号: ${accountLabel}\n✅ 50连抽成功\n\n${cardSummary}${paidSummary}${achievementSummary}`
  );
}

if (require.main === module) {
  run().catch((error) => {
    const errorMsg = error instanceof HybCardsError
      ? error.message
      : `未知错误: ${error.message || String(error)}`;

    console.error(`[hybgzs] 执行失败: ${errorMsg}`);
    if (error instanceof HybCardsError && error.details && Object.keys(error.details).length > 0) {
      console.error(`[hybgzs] 详细信息: ${JSON.stringify(error.details, null, 2)}`);
    }
    const notifyPromise = error.notificationSent
      ? Promise.resolve()
      : sendQinglongNotification(TASK_NAME, `❌ 发生异常：执行失败\n\n${errorMsg}`);

    notifyPromise.finally(() => {
      process.exitCode = 1;
    });
  });
}

module.exports = {
  DRAW_COUNT,
  DRAW_TYPE,
  HybCardsError,
  describeStatus,
  getConfig,
  getEligibility,
  getQinglongNotifyModule,
  normalizeBaseUrl,
  normalizeCookie,
  parseArgs,
  quotaToCurrency,
  requestJson,
  run,
  sendQinglongNotification,
  summarizeAchievements,
  summarizeCards,
};
