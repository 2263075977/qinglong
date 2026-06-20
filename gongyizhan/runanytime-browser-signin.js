#!/usr/bin/env node
// cron: 0 25 8 * * *
// new Env('随时跑路浏览器签到');
// description: 使用 Playwright 真实浏览器执行 runanytime.hxi.me 签到，适合需要 Turnstile 的场景

const fs = require('fs');
const path = require('path');

const DEFAULT_BASE_URL = 'https://runanytime.hxi.me';
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_LOGIN_WAIT_MS = 180000;
const TASK_NAME = '随时跑路浏览器签到';
const CHECKIN_API_RE = /\/api\/user\/checkin(?:\?|$)/;

class BrowserSignInError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'BrowserSignInError';
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
    headed: false,
    statusOnly: false,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--headed') {
      args.headed = true;
    } else if (arg === '--status-only') {
      args.statusOnly = true;
    } else {
      throw new BrowserSignInError(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printUsage() {
  console.log(`Usage: node gongyizhan/runanytime-browser-signin.js [options]

Options:
  --headed       Force a visible browser. Useful for first login / Turnstile debugging.
  --status-only  Open the personal page and report whether the session looks logged in.
  -h, --help     Show this help.

Required runtime:
  npm install playwright
  npx playwright install chromium

Environment:
  RUNANYTIME_BROWSER_HEADLESS       Optional, defaults to true. Set false for first manual login.
  RUNANYTIME_BROWSER_USER_DATA_DIR  Optional persistent profile dir.
  RUNANYTIME_BROWSER_CHANNEL        Optional Chromium channel, e.g. chrome.
  RUNANYTIME_BROWSER_EXECUTABLE     Optional Chromium executable path.
  RUNANYTIME_BROWSER_TIMEOUT_MS     Optional, defaults to ${DEFAULT_TIMEOUT_MS}.
  RUNANYTIME_LOGIN_WAIT_MS          Optional, defaults to ${DEFAULT_LOGIN_WAIT_MS}.
  RUNANYTIME_COOKIE                 Optional full Cookie header copied from browser.
  RUNANYTIME_USER_AGENT             Optional User-Agent matching copied Cookie.
  RUNANYTIME_BASE_URL               Optional, defaults to ${DEFAULT_BASE_URL}.`);
}

function getConfig(args) {
  loadDotEnv();

  const baseUrl = normalizeBaseUrl(envValue('RUNANYTIME_BASE_URL') || DEFAULT_BASE_URL, 'RUNANYTIME_BASE_URL');
  const userDataDir = envValue('RUNANYTIME_BROWSER_USER_DATA_DIR') ||
    path.join(__dirname, '.runanytime-browser-profile');
  const headless = args.headed
    ? false
    : parseBoolean(envValue('RUNANYTIME_BROWSER_HEADLESS'), true);
  const timeoutMs = parsePositiveInteger(envValue('RUNANYTIME_BROWSER_TIMEOUT_MS'), DEFAULT_TIMEOUT_MS);
  const loginWaitMs = parsePositiveInteger(envValue('RUNANYTIME_LOGIN_WAIT_MS'), DEFAULT_LOGIN_WAIT_MS);

  return {
    baseUrl,
    userDataDir,
    headless,
    timeoutMs,
    loginWaitMs,
    cookieHeader: envValue('RUNANYTIME_COOKIE'),
    userAgent: envValue('RUNANYTIME_USER_AGENT'),
    channel: envValue('RUNANYTIME_BROWSER_CHANNEL'),
    executablePath: envValue('RUNANYTIME_BROWSER_EXECUTABLE'),
  };
}

function envValue(name) {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBaseUrl(raw, envName) {
  try {
    const url = new URL(raw);
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch (error) {
    throw new BrowserSignInError(`Invalid ${envName}: ${raw}`);
  }
}

function parseBoolean(raw, fallback) {
  if (!raw) return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  return fallback;
}

function parsePositiveInteger(raw, fallback) {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (error) {
    throw new BrowserSignInError(
      'Missing Playwright. Install it with: npm install playwright && npx playwright install chromium'
    );
  }
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
      console.error(`[runanytime-browser] Failed to load Qinglong notify module: ${file}`);
      console.error(`[runanytime-browser] Notify load error: ${error.message}`);
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
    console.error(`[runanytime-browser] Qinglong notification failed: ${error.message}`);
    return false;
  }
}

async function launchContext(config) {
  const { chromium } = loadPlaywright();
  const launchOptions = {
    headless: config.headless,
    locale: 'zh-CN',
    viewport: { width: 1365, height: 900 },
    ignoreHTTPSErrors: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
  };

  if (config.channel) launchOptions.channel = config.channel;
  if (config.executablePath) launchOptions.executablePath = config.executablePath;
  if (config.userAgent) launchOptions.userAgent = config.userAgent;

  fs.mkdirSync(config.userDataDir, { recursive: true });
  const context = await chromium.launchPersistentContext(config.userDataDir, launchOptions);

  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
    } catch (error) {
      // Ignore hardened navigator objects.
    }
  });

  return context;
}

async function addCookiesFromHeader(context, baseUrl, cookieHeader) {
  if (!cookieHeader) return;

  const url = new URL(baseUrl);
  const cookies = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const equalsIndex = part.indexOf('=');
      if (equalsIndex === -1) return null;

      return {
        name: part.slice(0, equalsIndex).trim(),
        value: part.slice(equalsIndex + 1).trim(),
        domain: url.hostname,
        path: '/',
        secure: url.protocol === 'https:',
        sameSite: 'Lax',
      };
    })
    .filter((cookie) => cookie && cookie.name);

  if (cookies.length > 0) {
    await context.addCookies(cookies);
    console.log(`[runanytime-browser] Added ${cookies.length} cookies from RUNANYTIME_COOKIE.`);
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const config = getConfig(args);
  console.log(`[runanytime-browser] Start at ${new Date().toISOString()}`);
  console.log(`[runanytime-browser] Base URL: ${config.baseUrl}`);
  console.log(`[runanytime-browser] Headless: ${config.headless ? 'true' : 'false'}`);
  console.log(`[runanytime-browser] User data dir: ${config.userDataDir}`);

  let context;
  try {
    context = await launchContext(config);
    await addCookiesFromHeader(context, config.baseUrl, config.cookieHeader);

    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(config.timeoutMs);
    page.setDefaultNavigationTimeout(config.timeoutMs);

    const result = await runBrowserSignIn(page, config, args);
    await sendQinglongNotification(TASK_NAME, result.message);
    if (!result.success) process.exitCode = 1;
  } catch (error) {
    const body = `执行失败：${error.message}`;
    console.error(`[runanytime-browser] Failed: ${error.message}`);
    if (error instanceof BrowserSignInError && Object.keys(error.details).length > 0) {
      console.error(`[runanytime-browser] Details: ${JSON.stringify(error.details)}`);
    }
    await sendQinglongNotification(TASK_NAME, body);
    process.exitCode = 1;
  } finally {
    if (context) await context.close();
  }
}

async function runBrowserSignIn(page, config, args) {
  const personalUrl = `${config.baseUrl}/console/personal`;
  console.log(`[runanytime-browser] Opening ${personalUrl}`);
  await page.goto(personalUrl, { waitUntil: 'domcontentloaded' });
  await waitForSettledPage(page);

  if (await isLoginPage(page)) {
    await handleLoginRequired(page, config);
  }

  if (args.statusOnly) {
    const summary = await summarizePage(page);
    console.log(`[runanytime-browser] Status only: ${summary}`);
    return {
      success: true,
      message: `状态检查成功：${summary}`,
    };
  }

  const responsePromise = waitForCheckInResponse(page, config.timeoutMs);
  const clickText = await clickCheckInControl(page);
  console.log(`[runanytime-browser] Clicked check-in control: ${clickText}`);

  const apiResult = await responsePromise.catch(async (error) => {
    const pageText = await getVisibleText(page);
    if (isAlreadyCheckedInText(pageText)) {
      return {
        success: true,
        message: '页面显示今日已签到',
      };
    }
    throw error;
  });

  assertApiSuccess(apiResult);
  const message = describeApiResult(apiResult);
  console.log(`[runanytime-browser] ${message}`);
  return { success: true, message };
}

async function waitForSettledPage(page) {
  try {
    await page.waitForLoadState('networkidle', { timeout: 15000 });
  } catch (error) {
    await page.waitForTimeout(3000);
  }
}

async function isLoginPage(page) {
  const url = page.url();
  if (/\/login|\/register/i.test(url)) return true;

  const text = await getVisibleText(page);
  return /log in|sign in|登\s*录|登录|continue with linuxdo/i.test(text);
}

async function handleLoginRequired(page, config) {
  if (config.headless) {
    throw new BrowserSignInError(
      [
        'Browser profile is not logged in.',
        'Run once with RUNANYTIME_BROWSER_HEADLESS=false or --headed, finish login/Turnstile in the opened browser, then rerun headless.',
      ].join(' ')
    );
  }

  console.log(`[runanytime-browser] Login required. Finish login in the browser within ${config.loginWaitMs}ms.`);
  await page.waitForFunction(
    () => {
      const text = document.body ? document.body.innerText : '';
      return !/log in|sign in|登\s*录|登录|continue with linuxdo/i.test(text) &&
        location.pathname.includes('/console');
    },
    null,
    { timeout: config.loginWaitMs }
  );
  await waitForSettledPage(page);
}

function waitForCheckInResponse(page, timeoutMs) {
  return page.waitForResponse(
    (response) => CHECKIN_API_RE.test(new URL(response.url()).pathname + new URL(response.url()).search),
    { timeout: timeoutMs }
  ).then(parseApiResponse);
}

async function parseApiResponse(response) {
  const status = response.status();
  const text = await response.text();
  const json = parseMaybeJson(text);

  if (status < 200 || status >= 300) {
    throw new BrowserSignInError(`HTTP ${status} from check-in API`, {
      body: text.slice(0, 300),
      response: scrubResponse(json),
    });
  }

  if (json === null) {
    throw new BrowserSignInError('Non-JSON response from check-in API', {
      body: text.slice(0, 300),
    });
  }

  return json;
}

function parseMaybeJson(text) {
  if (!text.trim()) return {};

  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

async function clickCheckInControl(page) {
  const candidates = [
    /签到/,
    /check\s*in/i,
    /领取/,
    /每日/,
  ];

  for (const pattern of candidates) {
    const button = page.getByRole('button', { name: pattern }).first();
    try {
      await button.click({ timeout: 5000 });
      return pattern.toString();
    } catch (error) {
      // Try the next selector.
    }
  }

  const clickedText = await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    const target = elements.find((element) => {
      const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
      return /签到|check\s*in|领取|每日/i.test(text) && !element.disabled;
    });
    if (!target) return '';
    target.click();
    return (target.innerText || target.textContent || '').replace(/\s+/g, ' ').trim();
  });

  if (clickedText) return clickedText;

  const screenshot = path.join(process.cwd(), `runanytime-browser-no-button-${Date.now()}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  throw new BrowserSignInError('Could not find a check-in button on the page.', { screenshot });
}

function assertApiSuccess(result) {
  if (!result || typeof result !== 'object') {
    throw new BrowserSignInError('Unexpected empty check-in response');
  }

  const message = String(result.message || result.msg || result.error || '');
  if (
    result.success === true ||
    result.ret === 1 ||
    result.code === 0 ||
    /签到成功|已.*签到|already.*check/i.test(message)
  ) {
    return;
  }

  throw new BrowserSignInError(message || 'Check-in API returned a failure response', {
    response: scrubResponse(result),
  });
}

function describeApiResult(result) {
  const message = String(result.message || result.msg || '');
  const data = result.data || {};
  const awarded = typeof data.quota_awarded === 'number'
    ? `，奖励 ${describeQuota(data.quota_awarded)}`
    : '';
  const date = data.checkin_date || data.date || '';

  if (date || awarded) return `签到成功：${date || 'today'}${awarded}`;
  return message || '签到请求已完成';
}

function describeQuota(quota) {
  return `$${(quota / 500000).toLocaleString('en-US', {
    maximumFractionDigits: 4,
  })} (${quota.toLocaleString('en-US')} quota)`;
}

async function summarizePage(page) {
  const text = await getVisibleText(page);
  if (isAlreadyCheckedInText(text)) return '页面显示今日已签到';
  if (/签到|check\s*in/i.test(text)) return '页面已登录，找到签到相关内容';
  return '页面已登录，但未识别到签到状态';
}

async function getVisibleText(page) {
  try {
    return await page.evaluate(() => document.body ? document.body.innerText : '');
  } catch (error) {
    return '';
  }
}

function isAlreadyCheckedInText(text) {
  return /今日已签到|今天已签到|已经签到|已签到|already.*check/i.test(text);
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

if (require.main === module) {
  run();
}

module.exports = {
  BrowserSignInError,
  addCookiesFromHeader,
  describeApiResult,
  getConfig,
  isAlreadyCheckedInText,
  parseArgs,
  run,
  runBrowserSignIn,
};
