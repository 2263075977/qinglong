#!/usr/bin/env node
'use strict';
/**
 * cron: 30 8 * * *
 * new Env('老魔公益站签到');
 *
 * 必填环境变量:
 *   LAOMO_ACCOUNTS_JSON  JSON 数组: [{"cookie": "session=xxx", "username": "账号1"}]
 *   或
 *   LAOMO_COOKIE         单账号浏览器完整 Cookie
 *
 * 可选环境变量:
 *   LAOMO_USERNAME                  单账号备注名
 *   LAOMO_SITE_URL                  默认 https://api.2020111.xyz
 *   LAOMO_BROWSER_HEADLESS          true/false，默认 true
 *   LAOMO_BROWSER_TIMEOUT_MS        页面超时毫秒数，默认 90000
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH  Chromium 可执行文件路径
 */

const fs = require('node:fs');

const TASK_TITLE = '老魔公益站签到';
const DEFAULT_SITE_URL = 'https://api.2020111.xyz';
const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_QUOTA_PER_UNIT = 500000;
const CHROMIUM_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/opt/google/chrome/chrome',
];

class LaomoBrowserError extends Error {
  constructor(type, message) {
    super(message);
    this.name = 'LaomoBrowserError';
    this.type = type;
  }
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeCookieHeader(value) {
  return cleanString(value)
    .replace(/^cookie\s*:\s*/i, '')
    .replace(/[\r\n]+/g, '')
    .replace(/;\s*/g, '; ');
}

function parseCookiePairs(value) {
  const pairs = new Map();

  for (const rawPair of normalizeCookieHeader(value).split(';')) {
    const item = rawPair.trim();
    if (!item) continue;

    const separator = item.indexOf('=');
    if (separator <= 0) continue;

    const name = item.slice(0, separator).trim();
    const cookieValue = item.slice(separator + 1).trim();
    if (!name) continue;
    pairs.set(name, cookieValue);
  }

  return pairs;
}

// 从 session cookie 中尝试提取 userId
// gorilla/sessions 的 session 格式: base64(timestamp|base64(gob_encoded_data)|signature)
function extractUserIdFromSessionCookie(cookieHeader) {
  try {
    const pairs = parseCookiePairs(cookieHeader);
    const sessionValue = pairs.get('session');
    if (!sessionValue) return null;

    // 第一层 base64 解码
    const decoded1 = Buffer.from(sessionValue, 'base64').toString('utf8');

    // 分割 session：timestamp|data|signature
    const parts = decoded1.split('|');
    if (parts.length < 2) return null;

    // 第二层 base64 解码（gob 编码的数据）
    const decoded2 = Buffer.from(parts[1], 'base64');
    const text = decoded2.toString('binary');

    // 在解码后的数据中搜索 "id" 字段
    const idIndex = text.indexOf('id');
    if (idIndex === -1) return null;

    // gob 编码结构: "id" + 类型标记 + "int" + 字段类型 + 值
    // 典型结构: id\x03int\x04\x04\x00\xfe\x1b\x8c
    // 偏移 9 开始是值部分
    const offset = idIndex + 9;  // 跳过 "id\x03int\x04\x04\x00"

    if (offset + 3 > decoded2.length) return null;

    // 尝试读取 3 字节作为完整的 userId（大端序）
    // 0xfe1b8c = 16653196
    const userId = (decoded2[offset] << 16) | (decoded2[offset + 1] << 8) | decoded2[offset + 2];

    return userId && userId > 0 && userId < 2147483647 ? userId : null;
  } catch (error) {
    return null;
  }
}

function toPlaywrightCookies(cookieHeader, siteUrl) {
  const cookies = [];
  let domain;
  try {
    domain = new URL(siteUrl).hostname;
  } catch {
    throw new LaomoBrowserError('config_error', `无效的站点 URL: ${siteUrl}`);
  }

  for (const [name, value] of parseCookiePairs(cookieHeader)) {
    cookies.push({
      name,
      value,
      domain,
      path: '/',
      secure: true,
      sameSite: 'Lax',
    });
  }

  if (cookies.length === 0) {
    throw new LaomoBrowserError(
      'config_error',
      'Cookie 格式无效，未解析到任何 Cookie 键值对'
    );
  }
  return cookies;
}

function parseBoolean(value, fallback) {
  if (value == null || cleanString(String(value)) === '') return fallback;
  const text = cleanString(String(value)).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  throw new LaomoBrowserError('config_error', `无效布尔值: ${value}`);
}

function parsePositiveInteger(value, fallback) {
  if (value == null || cleanString(String(value)) === '') return fallback;
  const number = Number.parseInt(String(value), 10);
  if (!Number.isInteger(number) || number <= 0) {
    throw new LaomoBrowserError('config_error', `无效正整数: ${value}`);
  }
  return number;
}

function validateDisplayAvailability(headless, platform = process.platform, env = process.env) {
  if (!headless && platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    throw new LaomoBrowserError(
      'config_error',
      '有头模式需要 X Server；请设置 LAOMO_BROWSER_HEADLESS=true，'
        + '或使用 xvfb-run -a node gongyizhan/laomo-browser.js'
    );
  }
}

function resolveChromiumExecutable(explicitPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
  if (cleanString(explicitPath)) {
    const executablePath = cleanString(explicitPath);
    if (!fs.existsSync(executablePath)) {
      throw new LaomoBrowserError(
        'browser_error',
        `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 不存在: ${executablePath}`
      );
    }
    return executablePath;
  }

  return CHROMIUM_CANDIDATES.find(candidate => fs.existsSync(candidate));
}

function accountLabel(account) {
  return account.username ? `老魔公益站 / ${account.username}` : '老魔公益站';
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

function formatAccountResult(result) {
  const label = result.accountLabel || '老魔公益站';
  if (result.type === 'success') {
    const reward = result.reward != null ? `，获得 ${result.reward} 额度` : '';
    return `✅ ${label} 签到成功${reward}`;
  }
  if (result.type === 'already_checked') return `⏭️ ${label} 今日已签到`;
  if (result.type === 'challenge_required') {
    return `❌ ${label} 发生异常：验证阻断：${result.message}`;
  }
  return `❌ ${label} 发生异常：${result.message}`;
}

function formatResults(results) {
  return results.map(formatAccountResult).join('\n');
}

function formatQuotaReward(rawQuota, quotaPerUnit = DEFAULT_QUOTA_PER_UNIT) {
  const quota = Number(rawQuota);
  const configuredUnit = Number(quotaPerUnit);
  const unit = Number.isFinite(configuredUnit) && configuredUnit > 0
    ? configuredUnit
    : DEFAULT_QUOTA_PER_UNIT;
  if (!Number.isFinite(quota) || quota <= 0) return undefined;

  const reward = Math.round((quota / unit) * 1e6) / 1e6;
  return reward > 0 ? String(reward) : undefined;
}

// 判断响应文本是否为 Cloudflare / Turnstile 挑战页而非 JSON
function isChallengeHtml(text) {
  const lower = cleanString(text).toLowerCase();
  if (!lower) return false;
  return lower.includes('challenges.cloudflare.com')
    || lower.includes('cf-turnstile')
    || lower.includes('turnstile')
    || lower.includes('just a moment')
    || lower.includes('cf-browser-verification')
    || lower.includes('_cf_chl_opt')
    || lower.includes('bot detection');
}

// 从页面中提取 userId（优先从 localStorage 或全局变量）
async function extractUserId(page) {
  return page.evaluate(() => {
    try {
      // 尝试从 localStorage 获取用户信息
      const userStr = localStorage.getItem('user');
      if (userStr) {
        const user = JSON.parse(userStr);
        if (user?.id) return user.id;
      }
    } catch {}

    try {
      // 尝试从全局变量获取
      if (window.user?.id) return window.user.id;
      if (window.userInfo?.id) return window.userInfo.id;
    } catch {}

    return null;
  });
}

// 会话预检：/api/user/self 与 /api/user/checkin 走同一套 session 认证，
// 先探这里可提前区分 Cookie 失效、Cloudflare 挑战与网络异常，并拿到 userId
async function verifySession(page) {
  return page.evaluate(async () => {
    try {
      const response = await fetch('/api/user/self', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      const text = await response.text();

      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }

      return {
        authenticated: response.ok && payload?.success === true && Boolean(payload?.data),
        status: response.status,
        message: typeof payload?.message === 'string' ? payload.message : '',
        userId: payload?.data?.id ?? null,
        rawText: payload ? '' : text.slice(0, 2048),
        isJson: payload != null,
      };
    } catch (error) {
      return {
        authenticated: false,
        status: 0,
        message: error?.message || '网络请求失败',
        userId: null,
        rawText: '',
        isJson: false,
      };
    }
  });
}

async function checkinWithBrowser(page, userId) {
  // 在页面上下文内发起签到请求，自动携带所有 Cookie（含 Cloudflare 种的 cf_clearance）
  return page.evaluate(async apiUserId => {
    try {
      const headers = { 'Content-Type': 'application/json' };
      // 与站点前端一致：附带 New-API-User 头，兼容部分 newapi 分支
      if (apiUserId != null) headers['New-API-User'] = String(apiUserId);

      const response = await fetch('/api/user/checkin', {
        method: 'POST',
        headers,
        body: '{}',
        credentials: 'include',
      });

      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        // JSON 解析失败，可能是 Cloudflare 挑战页
        return {
          ok: false,
          status: response.status,
          message: '响应不是有效 JSON',
          data: null,
          rawText: text.slice(0, 2048),
          isJson: false,
        };
      }

      return {
        ok: response.ok && data?.success === true,
        status: response.status,
        message: typeof data?.message === 'string' ? data.message : '',
        data: data?.success === true ? data.data : null,
        rawText: '',
        isJson: true,
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        message: error?.message || '网络请求失败',
        data: null,
        rawText: '',
        isJson: false,
      };
    }
  }, userId);
}

async function fetchQuotaPerUnit(page) {
  return page.evaluate(async fallback => {
    try {
      const response = await fetch('/api/status', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => null);
      const quotaPerUnit = Number(payload?.data?.quota_per_unit);
      return Number.isFinite(quotaPerUnit) && quotaPerUnit > 0
        ? quotaPerUnit
        : fallback;
    } catch {
      return fallback;
    }
  }, DEFAULT_QUOTA_PER_UNIT);
}

function isAuthMessage(message) {
  const text = cleanString(message).toLowerCase();
  return text.includes('unauthorized')
    || text.includes('forbidden')
    || text.includes('not login')
    || text.includes('not logged')
    || text.includes('expired')
    || text.includes('invalid token')
    || text.includes('未登录')
    || text.includes('无权')
    || text.includes('未授权');
}

function isAlreadyCheckedMessage(message) {
  const text = cleanString(message);
  return text.includes('已签到')
    || text.includes('已经签到')
    || text.includes('今日已签到')
    || text.includes('今天已签到')
    || /already\s+checked/i.test(text)
    || /already\s+signed/i.test(text);
}

async function runAccount(browser, account, config) {
  let context;
  let page;

  try {
    const contextOptions = {
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      viewport: { width: 1365, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    };

    context = await browser.newContext(contextOptions);
    await context.addCookies(toPlaywrightCookies(account.cookie, config.siteUrl));

    page = await context.newPage();
    page.setDefaultTimeout(config.timeoutMs);

    // 导航到控制台页面，让 Cloudflare 完成指纹校验
    console.log(`[老魔公益站] 正在加载页面: ${config.siteUrl}/console/personal`);
    try {
      await page.goto(`${config.siteUrl}/console/personal`, {
        waitUntil: 'domcontentloaded',
        timeout: config.timeoutMs,
      });
    } catch (error) {
      // 如果页面加载超时，尝试等待 load 事件
      if (error?.name === 'TimeoutError') {
        console.log('[老魔公益站] domcontentloaded 超时，尝试继续执行...');
        try {
          await page.waitForLoadState('load', { timeout: 10000 });
        } catch {
          console.log('[老魔公益站] load 事件也超时，但继续执行...');
        }
      } else {
        throw error;
      }
    }

    // 等待页面稳定，Cloudflare challenge 自动完成
    // 增加等待时间，确保 Cloudflare 验证完全完成
    console.log('[老魔公益站] 等待 Cloudflare 验证完成...');
    await page.waitForTimeout(8000);

    // 检查当前 Cookie 状态
    const cookies = await context.cookies();
    console.log(`[老魔公益站] 当前 Cookie 数量: ${cookies.length}`);
    const hasCfClearance = cookies.some(c => c.name === 'cf_clearance');
    console.log(`[老魔公益站] cf_clearance 状态: ${hasCfClearance ? '已设置' : '未设置'}`);

    // 首先尝试从 session cookie 中提取 userId
    let userId = extractUserIdFromSessionCookie(account.cookie);
    console.log(`[老魔公益站] 从 session cookie 提取的用户 ID: ${userId || '未找到'}`);

    // 如果从 cookie 没有提取到，再尝试从页面中提取 userId
    if (!userId) {
      console.log('[老魔公益站] 正在从页面提取用户 ID...');
      userId = await extractUserId(page);
      console.log(`[老魔公益站] 从页面提取的用户 ID: ${userId || '未找到'}`);
    }

    // 会话预检：确认登录态，并提前区分 Cookie 失效 / Cloudflare 挑战 / 网络异常
    console.log('[老魔公益站] 开始验证会话状态...');
    const session = await verifySession(page);
    console.log(`[老魔公益站] 会话验证结果: authenticated=${session.authenticated}, status=${session.status}`);

    // 如果从页面没有提取到 userId，尝试从会话验证结果中获取
    if (!userId && session.userId) {
      userId = session.userId;
      console.log(`[老魔公益站] 从会话验证获取的用户 ID: ${userId}`);
    }

    // 如果会话验证失败但不是因为 "未提供 New-Api-User"，才判定为真正的失败
    // 某些站点的 /api/user/self 需要 New-API-User 头，但我们还没有 userId，所以允许这个错误
    const isNewApiUserError = session.message && session.message.includes('New-Api-User');

    if (!session.authenticated && !isNewApiUserError) {
      console.log(`[老魔公益站] 会话验证失败: ${session.message}`);
      if (session.rawText) {
        console.log(`[老魔公益站] 响应内容片段: ${session.rawText.slice(0, 200)}`);
      }

      if ([401, 403].includes(session.status) || isAuthMessage(session.message)) {
        return {
          type: 'auth_failed',
          message: 'Cookie 已失效或无权限，请重新获取 Cookie',
        };
      }
      if (!session.isJson && isChallengeHtml(session.rawText)) {
        return {
          type: 'challenge_required',
          message: 'Cloudflare 挑战未在无头模式下自动完成，请改用有头模式或网页手动处理',
        };
      }
      return {
        type: 'network_error',
        message: session.message || `无法验证登录态，HTTP ${session.status || '未知'}`,
      };
    }

    if (session.authenticated) {
      console.log(`[老魔公益站] 会话验证成功，用户 ID: ${session.userId}`);
    } else {
      console.log('[老魔公益站] 跳过会话预检（New-Api-User 问题），直接尝试签到...');
    }

    // 获取站点配置的积分单位
    console.log('[老魔公益站] 正在获取站点配置...');
    const quotaPerUnit = await fetchQuotaPerUnit(page);
    console.log(`[老魔公益站] 积分单位: ${quotaPerUnit}`);

    // 发起签到请求（附带提取到的 userId）
    console.log(`[老魔公益站] 正在发起签到请求... (userId: ${userId || '无'})`);
    const checkinResult = await checkinWithBrowser(page, userId);
    console.log(`[老魔公益站] 签到结果: ok=${checkinResult.ok}, status=${checkinResult.status}, message=${checkinResult.message}`);

    if (checkinResult.ok) {
      return {
        type: 'success',
        message: checkinResult.message || '签到成功',
        reward: formatQuotaReward(
          checkinResult.data?.reward ?? checkinResult.data?.quota_awarded,
          quotaPerUnit
        ),
      };
    }

    // 判断失败原因
    if ([401, 403].includes(checkinResult.status) || isAuthMessage(checkinResult.message)) {
      return {
        type: 'auth_failed',
        message: 'Cookie 已失效或无权限，请重新获取 Cookie',
      };
    }

    if (isAlreadyCheckedMessage(checkinResult.message)) {
      return {
        type: 'already_checked',
        message: '今日已签到',
      };
    }

    if (checkinResult.challenge) {
      return {
        type: 'challenge_required',
        message: 'Cloudflare 挑战未在无头模式下自动完成，请改用有头模式或网页手动处理',
      };
    }

    return {
      type: 'network_error',
      message: checkinResult.message || `签到失败，HTTP ${checkinResult.status || '未知'}`,
    };
  } finally {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
  }
}

async function runBrowserCheckins(accounts, config) {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    return accounts.map(account => ({
      accountLabel: accountLabel(account),
      type: 'browser_error',
      message: '未安装 Playwright，请在青龙环境安装 playwright 并准备 Chromium',
    }));
  }

  const launchOptions = {
    headless: config.headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
  };
  if (config.executablePath) launchOptions.executablePath = config.executablePath;

  let browser;
  try {
    browser = await chromium.launch(launchOptions);
  } catch (error) {
    const message = `Chromium 启动失败: ${error?.message || String(error)}`;
    return accounts.map(account => ({
      accountLabel: accountLabel(account),
      type: 'browser_error',
      message,
    }));
  }

  const results = [];
  try {
    for (const account of accounts) {
      console.log(`[老魔公益站] 开始处理账户: ${accountLabel(account)}`);
      try {
        const result = await runAccount(browser, account, config);
        results.push({ accountLabel: accountLabel(account), ...result });
      } catch (error) {
        const timeout = error?.name === 'TimeoutError' || /timeout/i.test(error?.message || '');
        results.push({
          accountLabel: accountLabel(account),
          type: timeout ? 'network_error' : 'browser_error',
          message: timeout
            ? '页面加载或签到等待超时'
            : `浏览器执行失败: ${error?.message || String(error)}`,
        });
      }

      // 多账号间隔 5 秒，避免 Cloudflare 频控
      if (accounts.indexOf(account) < accounts.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return results;
}

function printHelp() {
  console.log(`${TASK_TITLE}

用法:
  node gongyizhan/laomo-browser.js

必填环境变量（二选一）:
  LAOMO_ACCOUNTS_JSON       JSON 数组: [{"cookie": "session=xxx", "username": "账号1"}]
  LAOMO_COOKIE              单账号浏览器完整登录 Cookie

可选环境变量:
  LAOMO_USERNAME            单账号备注名（仅用于通知显示）
  LAOMO_SITE_URL            老魔站 URL，默认 ${DEFAULT_SITE_URL}
  LAOMO_BROWSER_HEADLESS    true/false，默认 true
  LAOMO_BROWSER_TIMEOUT_MS  页面超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH  Chromium 可执行文件路径

说明:
  脚本通过浏览器加载 Cookie 后访问控制台，让 Cloudflare Turnstile 自动完成。
  签到请求在页面上下文内发起，自动携带所有 Cookie（含 cf_clearance）。
  无头模式若无法通过 Turnstile，请设置 LAOMO_BROWSER_HEADLESS=false；
  Linux 青龙环境可使用 xvfb-run -a node gongyizhan/laomo-browser.js。`);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  let config;
  try {
    const siteUrl = cleanString(process.env.LAOMO_SITE_URL) || DEFAULT_SITE_URL;

    // 解析账号配置
    let accounts = [];
    const accountsJson = cleanString(process.env.LAOMO_ACCOUNTS_JSON);
    if (accountsJson) {
      try {
        const parsed = JSON.parse(accountsJson);
        if (!Array.isArray(parsed)) {
          throw new LaomoBrowserError(
            'config_error',
            'LAOMO_ACCOUNTS_JSON 必须是 JSON 数组'
          );
        }
        accounts = parsed.map((item, index) => {
          if (!item?.cookie || typeof item.cookie !== 'string') {
            throw new LaomoBrowserError(
              'config_error',
              `LAOMO_ACCOUNTS_JSON[${index}] 缺少有效 cookie 字段`
            );
          }
          return {
            cookie: normalizeCookieHeader(item.cookie),
            username: cleanString(item.username) || `账号${index + 1}`,
          };
        });
      } catch (error) {
        if (error instanceof LaomoBrowserError) throw error;
        throw new LaomoBrowserError(
          'config_error',
          `LAOMO_ACCOUNTS_JSON 解析失败: ${error.message}`
        );
      }
    }

    // 回退到单账号环境变量
    if (accounts.length === 0) {
      const cookie = normalizeCookieHeader(process.env.LAOMO_COOKIE);
      if (!cookie) {
        throw new LaomoBrowserError(
          'config_error',
          '未配置环境变量 LAOMO_ACCOUNTS_JSON 或 LAOMO_COOKIE'
        );
      }
      const username = cleanString(process.env.LAOMO_USERNAME) || '默认账号';
      accounts.push({ cookie, username });
    }

    // 验证所有账号的 Cookie 格式
    for (const account of accounts) {
      toPlaywrightCookies(account.cookie, siteUrl);
    }

    config = {
      siteUrl,
      executablePath: resolveChromiumExecutable(),
      headless: parseBoolean(process.env.LAOMO_BROWSER_HEADLESS, true),
      timeoutMs: parsePositiveInteger(
        process.env.LAOMO_BROWSER_TIMEOUT_MS,
        DEFAULT_TIMEOUT_MS
      ),
      accounts,
    };
    validateDisplayAvailability(config.headless);
  } catch (error) {
    await sendResult(TASK_TITLE, `❌ 发生异常：${error.message || String(error)}`);
    process.exitCode = 1;
    return;
  }

  const results = await runBrowserCheckins(config.accounts, config);
  await sendResult(TASK_TITLE, formatResults(results));
  if (results.some(result => !['success', 'already_checked'].includes(result.type))) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(async error => {
    await sendResult(TASK_TITLE, `❌ 发生异常：执行异常: ${error.message || String(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  LaomoBrowserError,
  accountLabel,
  checkinWithBrowser,
  cleanString,
  extractUserId,
  extractUserIdFromSessionCookie,
  fetchQuotaPerUnit,
  formatAccountResult,
  formatQuotaReward,
  formatResults,
  isAlreadyCheckedMessage,
  isAuthMessage,
  isChallengeHtml,
  normalizeCookieHeader,
  parseBoolean,
  parseCookiePairs,
  parsePositiveInteger,
  resolveChromiumExecutable,
  runAccount,
  runBrowserCheckins,
  toPlaywrightCookies,
  validateDisplayAvailability,
  verifySession,
};
