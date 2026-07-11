#!/usr/bin/env node
'use strict';
/**
 * cron: 25 8 * * *
 * new Env('RunAnytime 浏览器签到');
 *
 * 必填环境变量:
 *   RUNANYTIME_ACCOUNTS="完整 Cookie 字符串"
 *
 * 可选环境变量:
 *   RUNANYTIME_USER_ID=8514
 *   RUNANYTIME_BROWSER_HEADLESS=true
 *   RUNANYTIME_BROWSER_TIMEOUT_MS=90000
 *   RUNANYTIME_BROWSER_USER_AGENT="获取 Cookie 时浏览器的 User-Agent"
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
 */

const fs = require('node:fs');

const TASK_TITLE = 'RunAnytime 浏览器签到';
const SITE_URL = 'https://runanytime.hxi.me';
const PERSONAL_URL = `${SITE_URL}/console/personal`;
const COOKIE_ENV = 'RUNANYTIME_ACCOUNTS';
const DEFAULT_USER_ID = '8514';
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

class RunAnytimeBrowserError extends Error {
  constructor(type, message) {
    super(message);
    this.name = 'RunAnytimeBrowserError';
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

function parseCookieHeader(cookie) {
  const cookies = [];

  for (const pair of normalizeCookie(cookie).split(';')) {
    const item = pair.trim();
    if (!item) continue;

    const separator = item.indexOf('=');
    if (separator <= 0) continue;

    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (!name) continue;

    cookies.push({
      name,
      value,
      domain: 'runanytime.hxi.me',
      path: '/',
      secure: true,
      sameSite: 'Lax',
    });
  }

  if (cookies.length === 0) {
    throw new RunAnytimeBrowserError('config_error', `${COOKIE_ENV} 格式无效，未解析到 Cookie`);
  }

  return cookies;
}

function parseBoolean(value, fallback) {
  if (value == null || String(value).trim() === '') return fallback;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  throw new RunAnytimeBrowserError('config_error', `无效布尔值: ${value}`);
}

function parsePositiveInteger(value, fallback) {
  const number = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizeUserId(value, fallback = DEFAULT_USER_ID) {
  const userId = String(value || fallback).trim();
  if (!/^\d+$/.test(userId) || userId === '0') {
    throw new RunAnytimeBrowserError('config_error', `RUNANYTIME_USER_ID 无效: ${userId}`);
  }
  return userId;
}

function resolveChromiumExecutable(explicitPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
  if (explicitPath?.trim()) {
    const executablePath = explicitPath.trim();
    if (!fs.existsSync(executablePath)) {
      throw new RunAnytimeBrowserError(
        'config_error',
        `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 不存在: ${executablePath}`
      );
    }
    return executablePath;
  }

  return CHROMIUM_CANDIDATES.find(candidate => fs.existsSync(candidate));
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
  if (result.type === 'success') return `✅ ${result.message}`;
  if (result.type === 'already_checked') return '⏭️ 今日已签到';
  if (result.type === 'challenge_required') return `❌ 发生异常：验证阻断：${result.message}`;
  return `❌ 发生异常：${result.message}`;
}

async function readPageState(page) {
  const alreadyButton = page.getByRole('button', { name: '今日已签到', exact: true });
  if (await alreadyButton.count() === 1) return { type: 'already_checked' };

  const checkinButton = page.getByRole('button', { name: '立即签到', exact: true });
  if (await checkinButton.count() === 1) return { type: 'checkin_available', button: checkinButton };

  if (/\/login(?:[/?#]|$)/i.test(page.url())) {
    return { type: 'auth_failed' };
  }

  return { type: 'unknown' };
}

async function waitForPageState(page, timeoutMs) {
  const deadline = Date.now() + Math.min(timeoutMs, 20000);
  let state = await readPageState(page);

  while (state.type === 'unknown' && Date.now() < deadline) {
    await page.waitForTimeout(500);
    state = await readPageState(page);
  }

  return state;
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
        || message.includes('未登录')
        || message.includes('无权');

      return {
        authenticated: response.ok && payload?.success === true && Boolean(payload?.data),
        authFailed,
        status: response.status,
      };
    } catch {
      return { authenticated: false, authFailed: false, status: 0 };
    }
  });
}

async function runBrowserCheckin(config) {
  const { chromium } = require('playwright');
  const launchOptions = {
    headless: config.headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  };
  if (config.executablePath) launchOptions.executablePath = config.executablePath;

  let browser;
  let context;
  let page;

  try {
    browser = await chromium.launch(launchOptions);
    const contextOptions = {
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      viewport: { width: 1365, height: 900 },
    };
    if (config.userAgent) contextOptions.userAgent = config.userAgent;

    context = await browser.newContext(contextOptions);
    await context.setExtraHTTPHeaders({ 'New-Api-User': config.userId });
    await context.addInitScript(({ siteOrigin, user }) => {
      if (window.location.origin === siteOrigin) {
        window.localStorage.setItem('user', JSON.stringify(user));
      }
    }, {
      siteOrigin: SITE_URL,
      user: {
        id: Number(config.userId),
        username: `user_${config.userId}`,
        role: 1,
        status: 1,
        group: 'default',
      },
    });
    await context.addCookies(config.cookies);

    page = await context.newPage();
    page.setDefaultTimeout(config.timeoutMs);
    await page.goto(PERSONAL_URL, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });

    const sessionState = await verifySession(page);
    if (sessionState.authFailed) {
      return { type: 'auth_failed', message: 'Cookie 已失效，用户信息接口要求重新登录' };
    }
    if (!sessionState.authenticated) {
      return {
        type: 'network_error',
        message: `无法确认登录状态，用户信息接口 HTTP ${sessionState.status || '未知'}`,
      };
    }

    const initialState = await waitForPageState(page, config.timeoutMs);
    if (initialState.type === 'already_checked') {
      return { type: 'already_checked', message: '今日已签到' };
    }
    if (initialState.type === 'auth_failed') {
      return { type: 'auth_failed', message: 'Cookie 已失效，页面要求重新登录' };
    }
    if (initialState.type !== 'checkin_available') {
      return { type: 'schema_changed', message: '未找到“立即签到”或“今日已签到”按钮' };
    }

    await initialState.button.click();

    const deadline = Date.now() + config.timeoutMs;
    while (Date.now() < deadline) {
      const state = await readPageState(page);
      if (state.type === 'already_checked') {
        return { type: 'success', message: '浏览器签到成功' };
      }
      if (state.type === 'auth_failed') {
        return { type: 'auth_failed', message: '签到过程中登录状态失效' };
      }

      const securityDialog = page.getByText('Security Check', { exact: true });
      const chineseDialog = page.getByText('安全验证', { exact: true });
      const challengeVisible = await securityDialog.count() > 0 || await chineseDialog.count() > 0;
      if (challengeVisible && Date.now() + 5000 >= deadline) {
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
  } catch (error) {
    if (error instanceof RunAnytimeBrowserError) {
      return { type: error.type, message: error.message };
    }
    if (error?.name === 'TimeoutError' || /timeout/i.test(error?.message || '')) {
      return { type: 'network_error', message: '页面加载或签到等待超时' };
    }
    return { type: 'error', message: `浏览器执行失败: ${error?.message || String(error)}` };
  } finally {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

function printHelp() {
  console.log(`${TASK_TITLE}

用法:
  node gongyizhan/runanytime-browser.js

必填环境变量:
  ${COOKIE_ENV}                    RunAnytime 完整登录 Cookie

可选环境变量:
  RUNANYTIME_BROWSER_HEADLESS      true/false，默认 true
  RUNANYTIME_BROWSER_TIMEOUT_MS    页面和签到超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}
  RUNANYTIME_USER_ID               New API 用户 ID，默认 ${DEFAULT_USER_ID}
  RUNANYTIME_BROWSER_USER_AGENT    获取 Cookie 时浏览器的完整 User-Agent
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH  Chromium 可执行文件路径

说明:
  脚本通过站点网页自身完成 PoW 与 Turnstile，不读取或保存验证 token。
  无头模式若无法通过 Turnstile，请设置 RUNANYTIME_BROWSER_HEADLESS=false。`);
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
      cookies: parseCookieHeader(rawCookie),
      executablePath: resolveChromiumExecutable(),
      headless: parseBoolean(process.env.RUNANYTIME_BROWSER_HEADLESS, true),
      userAgent: process.env.RUNANYTIME_BROWSER_USER_AGENT?.trim() || '',
      userId: normalizeUserId(process.env.RUNANYTIME_USER_ID),
      timeoutMs: parsePositiveInteger(
        process.env.RUNANYTIME_BROWSER_TIMEOUT_MS,
        DEFAULT_TIMEOUT_MS
      ),
    };
  } catch (error) {
    await sendResult(TASK_TITLE, `❌ 发生异常：${error.message}`);
    process.exitCode = 1;
    return;
  }

  const result = await runBrowserCheckin(config);
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
  RunAnytimeBrowserError,
  formatResult,
  normalizeCookie,
  normalizeUserId,
  parseBoolean,
  parseCookieHeader,
  parsePositiveInteger,
  resolveChromiumExecutable,
  runBrowserCheckin,
  verifySession,
};
