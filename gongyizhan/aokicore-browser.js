#!/usr/bin/env node
'use strict';
/**
 * cron: 30 8 * * *
 * new Env('AokiCore 浏览器签到');
 *
 * 必填环境变量:
 *   AOKICORE_ACCOUNTS="浏览器完整 Cookie"
 *
 * 可选环境变量:
 *   AOKICORE_ACCOUNT_NAME="账户备注"
 *   AOKICORE_BROWSER_HEADLESS=true
 *   AOKICORE_BROWSER_TIMEOUT_MS=90000
 *   AOKICORE_BROWSER_USER_AGENT="获取 Cookie 时浏览器的 User-Agent"
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
 */

const fs = require('node:fs');

const TASK_TITLE = 'AokiCore 浏览器签到';
const SITE_ORIGIN = 'https://ai.muapi.cn';
const PROFILE_URL = `${SITE_ORIGIN}/profile`;
const COOKIE_ENV = 'AOKICORE_ACCOUNTS';
const DEFAULT_TIMEOUT_MS = 90000;
const CHROMIUM_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/opt/google/chrome/chrome',
];

class AokiCoreBrowserError extends Error {
  constructor(type, message) {
    super(message);
    this.name = 'AokiCoreBrowserError';
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

function toPlaywrightCookies(cookieHeader) {
  const cookies = [];
  for (const [name, value] of parseCookiePairs(cookieHeader)) {
    cookies.push({
      name,
      value,
      url: SITE_ORIGIN,
      secure: true,
      sameSite: 'Lax',
    });
  }
  if (cookies.length === 0) {
    throw new AokiCoreBrowserError(
      'config_error',
      `${COOKIE_ENV} 格式无效，未解析到 Cookie`
    );
  }
  return cookies;
}

function parseBoolean(value, fallback) {
  if (value == null || cleanString(String(value)) === '') return fallback;
  const text = cleanString(String(value)).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  throw new AokiCoreBrowserError('config_error', `无效布尔值: ${value}`);
}

function parsePositiveInteger(value, fallback) {
  if (value == null || cleanString(String(value)) === '') return fallback;
  const number = Number.parseInt(String(value), 10);
  if (!Number.isInteger(number) || number <= 0) {
    throw new AokiCoreBrowserError('config_error', `无效正整数: ${value}`);
  }
  return number;
}

function formatShanghaiDate(date = new Date(), includeDay = true) {
  const options = {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  };
  if (includeDay) options.day = '2-digit';

  const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return includeDay
    ? `${values.year}-${values.month}-${values.day}`
    : `${values.year}-${values.month}`;
}

function validateDisplayAvailability(headless, platform = process.platform, env = process.env) {
  if (!headless && platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    throw new AokiCoreBrowserError(
      'config_error',
      '有头模式需要 X Server；请设置 AOKICORE_BROWSER_HEADLESS=true，'
        + '或使用 xvfb-run -a node gongyizhan/aokicore-browser.js'
    );
  }
}

function resolveChromiumExecutable(explicitPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
  if (cleanString(explicitPath)) {
    const executablePath = cleanString(explicitPath);
    if (!fs.existsSync(executablePath)) {
      throw new AokiCoreBrowserError(
        'browser_error',
        `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 不存在: ${executablePath}`
      );
    }
    return executablePath;
  }

  return CHROMIUM_CANDIDATES.find(candidate => fs.existsSync(candidate));
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

function accountLabel(account) {
  return account.username ? `${account.siteName} / ${account.username}` : account.siteName;
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
  const prefix = result.accountLabel ? `${result.accountLabel}: ` : '';
  if (result.type === 'success') {
    const reward = result.reward != null ? `，奖励: ${result.reward}` : '';
    return `- [成功] ${prefix}${result.message}${reward}`;
  }
  if (result.type === 'already_checked') return `- [跳过] ${prefix}今日已签到`;
  if (result.type === 'challenge_required') {
    return `- [失败] ${prefix}❌ 发生异常：验证阻断：${result.message}`;
  }
  return `- [失败] ${prefix}❌ 发生异常：${result.message}`;
}

function formatResults(results) {
  const success = results.filter(result => result.type === 'success').length;
  const skipped = results.filter(result => result.type === 'already_checked').length;
  const failed = results.length - success - skipped;
  return [
    `成功: ${success}`,
    `跳过: ${skipped}`,
    `失败: ${failed}`,
    '',
    ...results.map(formatAccountResult),
  ].join('\n');
}

async function verifySession(page) {
  return page.evaluate(async () => {
    try {
      const response = await fetch('/api/user/self', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => null);
      const message = typeof payload?.message === 'string' ? payload.message : '';
      const lowerMessage = message.toLowerCase();
      const authFailed = response.status === 401
        || response.status === 403
        || lowerMessage.includes('unauthorized')
        || lowerMessage.includes('forbidden')
        || lowerMessage.includes('not login')
        || lowerMessage.includes('not logged')
        || lowerMessage.includes('expired')
        || message.includes('未登录')
        || message.includes('无权')
        || message.includes('未授权');

      return {
        authenticated: response.ok && payload?.success === true && Boolean(payload?.data),
        authFailed,
        status: response.status,
        user: payload?.success === true && payload?.data ? payload.data : null,
      };
    } catch {
      return { authenticated: false, authFailed: false, status: 0, user: null };
    }
  });
}

async function fetchCheckinStatus(page) {
  const month = formatShanghaiDate(new Date(), false);

  return page.evaluate(async currentMonth => {
    try {
      const response = await fetch(`/api/user/checkin?month=${encodeURIComponent(currentMonth)}`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => null);
      return {
        ok: response.ok && payload?.success === true && Boolean(payload?.data),
        status: response.status,
        message: typeof payload?.message === 'string' ? payload.message : '',
        data: payload?.data || null,
      };
    } catch {
      return { ok: false, status: 0, message: '', data: null };
    }
  }, month);
}

function readTodayReward(statusData) {
  const today = formatShanghaiDate();
  const records = statusData?.stats?.records;
  if (!Array.isArray(records)) return undefined;
  return records.find(record => record?.checkin_date === today)?.quota_awarded;
}

async function isTurnstileVisible(page) {
  const dialogText = page.getByText(/Security Check|安全验证|安全检查/i).first();
  const widget = page.locator(
    'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], .cf-turnstile'
  ).first();
  return (await dialogText.count()) > 0 || (await widget.count()) > 0;
}

async function findCheckinButton(page) {
  const button = page.getByRole('button', { name: /立即签到|Check in now/i }).first();
  return (await button.count()) > 0 ? button : null;
}

async function prepareAuthenticatedContext(browser, cookieHeader, config) {
  const contextOptions = {
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1365, height: 900 },
  };
  if (config.userAgent) contextOptions.userAgent = config.userAgent;

  const context = await browser.newContext(contextOptions);
  let page;

  try {
    await context.addCookies(toPlaywrightCookies(cookieHeader));
    page = await context.newPage();
    page.setDefaultTimeout(config.timeoutMs);
    await page.goto(SITE_ORIGIN, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });

    const session = await verifySession(page);
    if (!session.authenticated) {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
      return { context: null, page: null, session };
    }

    const userId = session.user?.id;
    if (userId != null) {
      await context.setExtraHTTPHeaders({ 'New-Api-User': String(userId) });
    }
    await page.evaluate(user => {
      window.localStorage.setItem('user', JSON.stringify(user));
    }, session.user);
    await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
    return { context, page, session };
  } catch (error) {
    await page?.close().catch(() => {});
    await context.close().catch(() => {});
    throw error;
  }
}

async function runAccount(browser, account, config) {
  let context;
  let page;

  try {
    const prepared = await prepareAuthenticatedContext(browser, account.cookie, config);
    context = prepared.context;
    page = prepared.page;
    if (!context || !page) {
      if (prepared.session?.authFailed) {
        return { type: 'auth_failed', message: `Cookie 已失效，请更新 ${COOKIE_ENV}` };
      }
      return {
        type: 'auth_failed',
        message: `无法建立 AokiCore 网页登录态，请重新获取完整 ${COOKIE_ENV}`,
      };
    }

    const initialStatus = await fetchCheckinStatus(page);
    if (!initialStatus.ok) {
      if ([401, 403].includes(initialStatus.status) || isAuthMessage(initialStatus.message)) {
        return { type: 'auth_failed', message: 'Cookie 已失效，签到状态接口要求重新登录' };
      }
      return {
        type: 'network_error',
        message: `无法获取签到状态，HTTP ${initialStatus.status || '未知'}`,
      };
    }

    if (initialStatus.data?.stats?.checked_in_today === true) {
      return {
        type: 'already_checked',
        message: '今日已签到',
        reward: readTodayReward(initialStatus.data),
      };
    }

    const button = await findCheckinButton(page);
    if (!button) {
      if (/\/login(?:[/?#]|$)/i.test(page.url())) {
        return { type: 'auth_failed', message: `页面要求重新登录，请更新 ${COOKIE_ENV}` };
      }
      return { type: 'schema_changed', message: '未找到“立即签到”按钮，AokiCore 页面结构可能已变化' };
    }

    await button.click();
    const deadline = Date.now() + config.timeoutMs;
    while (Date.now() < deadline) {
      const status = await fetchCheckinStatus(page);
      if (status.ok && status.data?.stats?.checked_in_today === true) {
        return {
          type: 'success',
          message: '浏览器签到成功',
          reward: readTodayReward(status.data),
        };
      }
      if ([401, 403].includes(status.status) || isAuthMessage(status.message)) {
        return { type: 'auth_failed', message: '签到过程中登录状态失效' };
      }
      if (await isTurnstileVisible(page) && Date.now() + 5000 >= deadline) {
        return {
          type: 'challenge_required',
          message: 'Turnstile 未在超时内自动完成，请改用有头模式或网页手动签到',
        };
      }
      await page.waitForTimeout(1000);
    }

    return {
      type: 'challenge_required',
      message: '签到状态在超时内未更新，Turnstile 可能需要人工处理',
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
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
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
      console.log(`[AokiCore] 开始处理账户: ${accountLabel(account)}`);
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
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return results;
}

function printHelp() {
  console.log(`${TASK_TITLE}

用法:
  node gongyizhan/aokicore-browser.js

必填环境变量:
  ${COOKIE_ENV}                   AokiCore 浏览器完整登录 Cookie

可选环境变量:
  AOKICORE_ACCOUNT_NAME           账户备注，仅用于通知显示
  AOKICORE_BROWSER_HEADLESS       true/false，默认 true
  AOKICORE_BROWSER_TIMEOUT_MS     页面和签到超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}
  AOKICORE_BROWSER_USER_AGENT     获取 Cookie 时浏览器的完整 User-Agent
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH  Chromium 可执行文件路径

说明:
  脚本通过 AokiCore 官方网页完成 Turnstile，不读取或保存验证 token。
  无头模式若无法通过 Turnstile，请设置 AOKICORE_BROWSER_HEADLESS=false；
  Linux 青龙环境可使用 xvfb-run -a node gongyizhan/aokicore-browser.js。`);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  let config;
  try {
    const cookie = normalizeCookieHeader(process.env[COOKIE_ENV]);
    if (!cookie) {
      throw new AokiCoreBrowserError(
        'config_error',
        `未配置环境变量 ${COOKIE_ENV}`
      );
    }
    toPlaywrightCookies(cookie);

    config = {
      executablePath: resolveChromiumExecutable(),
      headless: parseBoolean(process.env.AOKICORE_BROWSER_HEADLESS, true),
      timeoutMs: parsePositiveInteger(
        process.env.AOKICORE_BROWSER_TIMEOUT_MS,
        DEFAULT_TIMEOUT_MS
      ),
      userAgent: cleanString(process.env.AOKICORE_BROWSER_USER_AGENT),
    };
    validateDisplayAvailability(config.headless);

    const accountName = cleanString(process.env.AOKICORE_ACCOUNT_NAME);
    config.accounts = [{
      siteName: accountName || 'AokiCore',
      username: '',
      cookie,
    }];
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
  AokiCoreBrowserError,
  cleanString,
  fetchCheckinStatus,
  formatShanghaiDate,
  formatAccountResult,
  formatResults,
  isAuthMessage,
  normalizeCookieHeader,
  parseBoolean,
  parseCookiePairs,
  parsePositiveInteger,
  readTodayReward,
  resolveChromiumExecutable,
  runBrowserCheckins,
  toPlaywrightCookies,
  validateDisplayAvailability,
  verifySession,
};
