#!/usr/bin/env node
// cron: 25 8 * * *
// new Env('黑与白福利站 Dashboard Playwright 自动化');
// description: 使用 Playwright 持久化浏览器会话执行 HYB Dashboard 签到和大转盘

const { chromium } = require('playwright');
const path = require('path');

const LOG_PREFIX = '[hybgzs-dashboard]';
const PROFILE_DIR = path.join(__dirname, '.browser-profile');
const BASE_URL = 'https://cdk.hybgzs.com';
const DASHBOARD_URL = `${BASE_URL}/dashboard`;
const CHECKIN_URL = `${BASE_URL}/gas-station/checkin`;
const WHEEL_URL = `${BASE_URL}/entertainment/wheel`;
const VIEWPORT = { width: 1280, height: 720 };
const LOAD_TIMEOUT_MS = 60000;
const ACTION_TIMEOUT_MS = 10 * 60 * 1000;

// 环境变量配置（支持多种布尔值写法）
const HEADLESS = ['true', '1', 'yes'].includes(process.env.PLAYWRIGHT_HEADLESS?.toLowerCase());

const CHECKIN_BUTTON_SELECTORS = [
  'button:has-text("立即签到")',
  'button:has-text("今日签到")',
  'button:has-text("签到")',
  'button:has-text("领取")',
  '[role="button"]:has-text("签到")',
];

const WHEEL_BUTTON_SELECTORS = [
  'button:has-text("立即抽奖")',
  'button:has-text("开始抽奖")',
  'button:has-text("抽奖")',
  'button:has-text("转盘")',
  'button:has-text("点击抽奖")',
  '[role="button"]:has-text("抽奖")',
  '[role="button"]:has-text("转盘")',
];

class HybDashboardPlaywrightError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'HybDashboardPlaywrightError';
    this.details = details;
  }
}

function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

function warn(message) {
  console.warn(`${LOG_PREFIX} ${message}`);
}

function getData(response) {
  if (!response || typeof response !== 'object') return {};
  if (response.data && typeof response.data === 'object') return response.data;
  return response;
}

function getNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function isSuccessResponse(response) {
  if (!response || typeof response !== 'object') return false;
  if (response.success === false || response.ok === false) return false;
  return true;
}

function summarizeCheckin(data) {
  const result = getData(data);
  const parts = ['签到成功'];
  const message = result.message || data?.message;
  const reward = result.rewardQuota ?? result.reward ?? result.quota ?? result.todayExpectedReward;
  const balance = result.walletBalance ?? result.balance;

  if (message) parts.push(String(message));
  if (reward !== undefined) parts.push(`奖励: ${reward}`);
  if (balance !== undefined) parts.push(`余额: ${balance}`);
  return parts.join('，');
}

function summarizeWheel(data) {
  const result = getData(data);
  const prize = result.prize || {};
  const prizeName = prize.name || result.prizeName || result.name || '未返回奖品名称';
  const amount = prize.amount ?? result.rewardQuota ?? result.amount ?? result.reward;
  const parts = [`大转盘成功: ${prizeName}`];

  if (amount !== undefined) parts.push(`奖励: ${amount}`);
  if (result.remainingSpins !== undefined) parts.push(`剩余次数: ${result.remainingSpins}`);
  if (result.isGuarantee) parts.push('触发保底');
  return parts.join('，');
}

function formatApiError(label, payload) {
  if (!payload) return `${label} 未返回响应`;
  const message = payload.message || payload.error || payload.msg;
  if (message) return `${label} 失败: ${message}`;
  return `${label} 失败: 响应结构无法识别`;
}

async function waitForNetworkIdle(page, label) {
  try {
    await page.waitForLoadState('networkidle', { timeout: LOAD_TIMEOUT_MS });
  } catch (error) {
    warn(`${label} networkidle 等待超时，继续按当前页面状态执行`);
  }
}

async function gotoAndSettle(page, url, label) {
  log(`打开${label}: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: LOAD_TIMEOUT_MS });
  await waitForNetworkIdle(page, label);
}

async function fetchJsonInPage(page, apiPath, options = {}) {
  const url = apiPath.startsWith('http') ? apiPath : `${BASE_URL}${apiPath}`;
  const result = await page.evaluate(
    async ({ requestUrl, requestOptions }) => {
      const response = await fetch(requestUrl, {
        method: requestOptions.method || 'GET',
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          ...(requestOptions.headers || {}),
        },
        credentials: 'include',
        body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body),
      });

      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch (error) {
        json = null;
      }

      return {
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get('content-type') || '',
        json,
        text: text.slice(0, 500),
      };
    },
    { requestUrl: url, requestOptions: options }
  );

  if (!result.ok) {
    throw new HybDashboardPlaywrightError(`${apiPath} 返回 HTTP ${result.status}`, result);
  }
  if (!result.json) {
    throw new HybDashboardPlaywrightError(`${apiPath} 未返回 JSON`, result);
  }
  return result.json;
}

async function ensureLoggedIn(page) {
  // 检测 Cloudflare challenge 页面
  const hasChallenge = await page.locator('[id*="challenge"], [class*="challenge"], [class*="cf-"]').count().catch(() => 0);
  if (hasChallenge > 0) {
    warn('检测到 Cloudflare 验证页面，会话可能已过期。首次运行或会话失效时需要手动完成验证。');
  }

  const dashboardState = await fetchJsonInPage(page, '/api/dashboard/stats').catch((error) => {
    if (error.details?.status === 401 || error.details?.status === 403) return null;
    throw error;
  });

  if (dashboardState) return dashboardState;

  log('检测到未登录或会话失效。首次运行请在打开的浏览器中登录并完成 CAP 验证。');
  await page.waitForURL(/\/dashboard(?:\?|$)/, { timeout: ACTION_TIMEOUT_MS });
  await waitForNetworkIdle(page, '登录后 dashboard 页面');

  const verifiedState = await fetchJsonInPage(page, '/api/dashboard/stats');
  if (!isSuccessResponse(verifiedState)) {
    throw new HybDashboardPlaywrightError(formatApiError('验证登录状态', verifiedState), verifiedState);
  }
  return verifiedState;
}

async function findActionButton(page, selectors, actionName) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const count = await locator.count().catch(() => 0);
    if (count === 0) continue;

    const visible = await locator.isVisible().catch(() => false);
    const disabled = await locator.isDisabled().catch(() => false);
    if (visible && !disabled) {
      log(`${actionName}按钮命中选择器: ${selector}`);
      return locator;
    }
  }

  throw new HybDashboardPlaywrightError(
    `未找到可点击的${actionName}按钮，页面 DOM 可能已变化，需要调整选择器`
  );
}

async function clickAndWaitForResponse(page, button, apiPath, actionName) {
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes(apiPath) && response.request().method() === 'POST',
    { timeout: ACTION_TIMEOUT_MS }
  );

  await button.click();
  log(`已点击${actionName}按钮，等待 ${apiPath} 响应；如果出现 CAP，请在浏览器窗口完成验证`);

  const response = await responsePromise;
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (error) {
    throw new HybDashboardPlaywrightError(`${actionName}响应不是 JSON`, {
      status: response.status(),
      text: text.slice(0, 500),
    });
  }

  if (!response.ok() || !isSuccessResponse(json)) {
    throw new HybDashboardPlaywrightError(formatApiError(actionName, json), {
      status: response.status(),
      json,
    });
  }

  return json;
}

async function performCheckin(page) {
  await gotoAndSettle(page, CHECKIN_URL, '签到页面');

  const status = getData(await fetchJsonInPage(page, '/api/checkin/status'));
  const config = getData(await fetchJsonInPage(page, '/api/checkin/config'));

  log(`签到状态: enabled=${status.enabled !== false}, checked=${config.hasCheckedInToday === true}, capRequired=${status.capRequired === true || config.capRequired === true}`);

  if (status.enabled === false) return { type: 'skipped', message: '签到功能已关闭' };
  if (config.hasCheckedInToday === true) return { type: 'already_done', message: '今日已签到' };

  const button = await findActionButton(page, CHECKIN_BUTTON_SELECTORS, '签到');
  const result = await clickAndWaitForResponse(page, button, '/api/checkin', '签到');
  return { type: 'success', message: summarizeCheckin(result), raw: result };
}

async function performWheel(page) {
  await gotoAndSettle(page, WHEEL_URL, '大转盘页面');

  const wheelState = getData(await fetchJsonInPage(page, '/api/wheel'));
  let remainingSpins = getNumber(wheelState.remainingSpins, 0);
  const results = [];

  log(`大转盘状态: remainingSpins=${remainingSpins}, totalSpins=${getNumber(wheelState.totalSpins, 0)}, capRequired=${wheelState.capRequired === true}`);

  if (remainingSpins <= 0) {
    return [{ type: 'already_done', message: '今日转盘次数不足或已用完' }];
  }

  while (remainingSpins > 0) {
    const button = await findActionButton(page, WHEEL_BUTTON_SELECTORS, '大转盘');
    const result = await clickAndWaitForResponse(page, button, '/api/wheel', '大转盘');
    const data = getData(result);
    results.push({ type: 'success', message: summarizeWheel(result), raw: result });

    if (typeof data.remainingSpins === 'number') {
      remainingSpins = data.remainingSpins;
    } else {
      remainingSpins -= 1;
    }

    if (remainingSpins > 0) {
      await page.waitForTimeout(1500);
    }
  }

  return results;
}

async function runWithPersistentContext() {
  // 首次运行必须保持 headless=false：用户需要在真实浏览器窗口中登录并完成 CAP。
  // Playwright 会把 Cookie、localStorage 等会话状态保存到 PROFILE_DIR。
  // 后续运行复用同一个目录，一般可以直接进入 dashboard 并完成自动化。
  // 使用环境变量 PLAYWRIGHT_HEADLESS=true/1/yes 启用无头模式
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    viewport: VIEWPORT,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  let page;
  try {
    page = browser.pages()[0] || await browser.newPage();
    page.setDefaultTimeout(LOAD_TIMEOUT_MS);

    log(`使用持久化浏览器目录: ${PROFILE_DIR}`);
    await gotoAndSettle(page, DASHBOARD_URL, 'Dashboard 页面');
    await ensureLoggedIn(page);

    const checkinResult = await performCheckin(page).catch((error) => ({
      type: 'error',
      message: error.message || String(error),
    }));
    log(`签到结果: ${checkinResult.message}`);

    const wheelResults = await performWheel(page).catch((error) => ([{
      type: 'error',
      message: error.message || String(error),
    }]));
    for (const [index, result] of wheelResults.entries()) {
      log(`大转盘结果 ${index + 1}: ${result.message}`);
    }

    const hasFailure = checkinResult.type === 'error' || wheelResults.some((result) => result.type === 'error');
    if (hasFailure) process.exitCode = 1;
  } finally {
    await browser.close();
    log('浏览器已关闭');
  }
}

if (require.main === module) {
  runWithPersistentContext().catch((error) => {
    console.error(`${LOG_PREFIX} 执行失败: ${error.message || String(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  CHECKIN_BUTTON_SELECTORS,
  PROFILE_DIR,
  WHEEL_BUTTON_SELECTORS,
  fetchJsonInPage,
  performCheckin,
  performWheel,
  runWithPersistentContext,
};
