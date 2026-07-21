#!/usr/bin/env node
/**
 * cron: 5 0 * * *
 * new Env('SharedChat Vibe Code 权益领取');
 *
 * 必填环境变量:
 *   SHAREDCHAT_COOKIE="完整 Cookie 字符串"
 *
 * 可选环境变量:
 *   SHAREDCHAT_CLAIM_REASON_PREFIX="用于学习 Codex 编程并完成个人项目"
 *   SHAREDCHAT_TIMEOUT_MS=60000
 *   SHAREDCHAT_CHALLENGE_WAIT_MS=15000
 *   SHAREDCHAT_USER_AGENT="获取 Cookie 时浏览器的 User-Agent"
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
 */

'use strict';

const fs = require('node:fs');
const { chromium } = require('playwright');

const SITE_URL = 'https://new.sharedchat.cc';
const DASHBOARD_URL = `${SITE_URL}/list/#/vibe-code/dashboard`;
const QUOTA_PATH = '/frontend-api/vibe-code/quota';
const CLAIM_PATH = '/frontend-api/vibe-code/codex/claim';
const TASK_TITLE = 'SharedChat Vibe Code 权益领取';
const LOG_PREFIX = '[sharedchat-vibe]';
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_REASON_PREFIX = '用于每日学习 Codex 编程并完成个人项目';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';
const DEFAULT_CHALLENGE_WAIT_MS = 15000;
const CHALLENGE_POLL_INTERVAL_MS = 1000;
const CLAIM_ATTEMPT_LIMIT = 2;
const CLAIM_VERIFICATION_ATTEMPTS = 4;
const CLAIM_VERIFICATION_INTERVAL_MS = 1500;
const CHROMIUM_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/opt/google/chrome/chrome',
];

class SharedChatClaimError extends Error {
  constructor(type, message) {
    super(message);
    this.name = 'SharedChatClaimError';
    this.type = type;
  }
}

function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

function parsePositiveInteger(value, fallback) {
  const number = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizeCookie(cookie) {
  return String(cookie || '')
    .trim()
    .replace(/^cookie\s*:\s*/i, '')
    .replace(/[\r\n]+/g, '')
    .replace(/;\s*/g, '; ');
}

function parseCookieHeader(cookie) {
  const normalized = normalizeCookie(cookie);
  const cookies = [];

  for (const pair of normalized.split(';')) {
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
      domain: 'new.sharedchat.cc',
      path: '/',
      secure: true,
      sameSite: 'Lax',
    });
  }

  if (cookies.length === 0) {
    throw new SharedChatClaimError('config_error', 'SHAREDCHAT_COOKIE 格式无效，未解析到 Cookie');
  }

  return cookies;
}

function shanghaiDateStamp(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function buildClaimReason(prefix = DEFAULT_REASON_PREFIX, date = new Date()) {
  const normalizedPrefix = String(prefix || DEFAULT_REASON_PREFIX).trim() || DEFAULT_REASON_PREFIX;
  const reason = `${normalizedPrefix}，领取日期 ${shanghaiDateStamp(date)}`;

  if (reason.length < 10) {
    throw new SharedChatClaimError('config_error', '领取原因不能少于 10 个字');
  }

  return reason;
}

function resolveChromiumExecutable(explicitPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
  if (explicitPath?.trim()) {
    const executablePath = explicitPath.trim();
    if (!fs.existsSync(executablePath)) {
      throw new SharedChatClaimError(
        'config_error',
        `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 不存在: ${executablePath}`
      );
    }
    return executablePath;
  }

  return CHROMIUM_CANDIDATES.find(candidate => fs.existsSync(candidate));
}

function extractMessage(payload) {
  return typeof payload?.message === 'string' && payload.message.trim()
    ? payload.message.trim()
    : typeof payload?.msg === 'string' && payload.msg.trim()
      ? payload.msg.trim()
      : typeof payload?.data?.message === 'string' && payload.data.message.trim()
        ? payload.data.message.trim()
        : '';
}

function isAuthMessage(message) {
  const text = String(message || '').toLowerCase();
  return text.includes('unauthorized')
    || text.includes('forbidden')
    || text.includes('not login')
    || text.includes('not logged')
    || text.includes('expired')
    || text.includes('未登录')
    || text.includes('登录失效')
    || text.includes('请登录')
    || text.includes('无权限');
}

function isAlreadyClaimedMessage(message) {
  const text = String(message || '').toLowerCase();
  return text.includes('already claimed')
    || text.includes('already subscribed')
    || text.includes('今日已领取')
    || text.includes('今天已领取')
    || text.includes('已经领取')
    || text.includes('已领取')
    || text.includes('权益已生效');
}

function isSuccessMessage(message) {
  const text = String(message || '').trim().toLowerCase();
  return [
    'success',
    'successful',
    'ok',
    'claim success',
    'claimed successfully',
    '领取成功',
    '操作成功',
  ].includes(text);
}

function getCodexQuota(payload) {
  const data = payload?.code === 1 && payload?.data ? payload.data : payload;
  return data?.codex && typeof data.codex === 'object' ? data.codex : null;
}

function analyzeQuotaResponse(status, payload) {
  const message = extractMessage(payload);

  if (status === 401 || status === 403 || isAuthMessage(message)) {
    return { type: 'auth_failed', message: 'Cookie 已失效或登录状态无效' };
  }

  const codex = getCodexQuota(payload);
  if (!codex) {
    return { type: 'schema_changed', message: '配额接口响应结构已变化' };
  }

  if (codex.isAuth === false) {
    return { type: 'auth_failed', message: '当前账号无 Codex 权限或登录状态无效' };
  }

  const subscription = codex.subscriptions;
  if (subscription && subscription.isActive === true) {
    return {
      type: 'already_claimed',
      message: '今日权益已领取，Codex 套餐生效中',
      packageName: subscription.subTypeName || '',
      resetTime: subscription.periodResetTime || '',
    };
  }

  return { type: 'claimable', message: '当前没有生效中的 Codex 权益' };
}

function analyzeClaimResponse(status, payload) {
  const message = extractMessage(payload);

  if (status === 401 || status === 403 || isAuthMessage(message)) {
    return { type: 'auth_failed', message: 'Cookie 已失效或登录状态无效' };
  }

  if (!payload || typeof payload !== 'object') {
    return { type: 'schema_changed', message: '领取接口未返回有效 JSON' };
  }

  if (status < 200 || status >= 300) {
    return {
      type: 'error',
      message: message || `领取失败: HTTP ${status}`,
    };
  }

  const data = payload.data;
  if (payload.code === 1 && data && typeof data === 'object' && data.claimed === true) {
    return { type: 'success', message: message || payload.data.message || '领取成功' };
  }

  if (payload.code === 1 && data && typeof data === 'object' && data.subscribed === true) {
    return { type: 'already_claimed', message: message || payload.data.message || '权益已生效' };
  }

  if (isAlreadyClaimedMessage(message)) {
    return { type: 'already_claimed', message: '今日权益已领取' };
  }

  const lowerMessage = message.toLowerCase();
  if (lowerMessage.includes('fingerprint') || message.includes('浏览器') || message.includes('验证')) {
    return { type: 'challenge_required', message: '浏览器指纹或验证未通过，请手动领取' };
  }

  if (payload.success === true || isSuccessMessage(message)) {
    return {
      type: 'pending_verification',
      message: '领取接口已受理，等待配额状态确认',
    };
  }

  return { type: 'error', message: message || '领取失败，接口未确认领取结果' };
}

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
      await Promise.resolve(sendNotify(title, content));
      return true;
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} 青龙通知发送失败: ${error.message}`);
  }

  console.log(`\n${title}\n${content}`);
  return false;
}

async function fetchJsonInPage(page, path, options = {}) {
  const result = await page.evaluate(async ({ requestPath, requestOptions }) => {
    try {
      const response = await fetch(requestPath, {
        method: requestOptions.method || 'GET',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          ...(requestOptions.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: requestOptions.body ? JSON.stringify(requestOptions.body) : undefined,
      });
      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {}
      return { ok: response.ok, status: response.status, json };
    } catch (error) {
      return { ok: false, status: 0, json: null, networkError: error.message || String(error) };
    }
  }, { requestPath: path, requestOptions: options });

  if (result.networkError) {
    throw new SharedChatClaimError('network_error', '请求站点接口失败');
  }

  return result;
}

/**
 * 精准挑战检测：只认「真实可见的 Cloudflare/Turnstile widget」或「Cloudflare 全页拦截页」，
 * 不再对 body.innerText 做宽泛关键词扫描（会把正常页面文案误判为验证）。
 * 返回结构化信号供上层决定是否等待自愈或按拦截处理。
 */
async function detectChallengeSignal(page) {
  return page.evaluate(() => {
    const signal = {
      blocked: false,
      kind: '',
      detail: '',
      title: document.title || '',
      url: location.href,
    };

    // 1. 真实可见的挑战 widget（对齐同仓库 runanytime-browser 的 isChallengeVisible 思路）
    const widgets = document.querySelectorAll(
      'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], '
        + '.cf-turnstile, #cf-challenge-running, #challenge-form'
    );
    for (const el of widgets) {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const visible = style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
      if (visible) {
        signal.blocked = true;
        signal.kind = 'turnstile-widget';
        signal.detail = `visible <${el.tagName.toLowerCase()}> `
          + `${el.getAttribute('src') || el.className || el.id || ''}`.trim();
        return signal;
      }
    }

    // 2. Cloudflare 全页拦截页（Just a moment / Attention Required），需标题特征与挑战脚本同时命中
    const title = signal.title.toLowerCase();
    const interstitialTitle = /just a moment|attention required|checking your browser|请稍候/.test(title);
    const challengeScript = /cf-chl-|__cf_chl|window\._cf_chl|challenges\.cloudflare\.com/i
      .test(document.documentElement.innerHTML);
    if (interstitialTitle && challengeScript) {
      signal.blocked = true;
      signal.kind = 'cloudflare-interstitial';
      signal.detail = `title="${signal.title}"`;
      return signal;
    }

    return signal;
  });
}

/**
 * 等待 dashboard 就绪：
 *   - 以「配额接口能返回有效 JSON」为页面可用的 ground truth（挑战已过 / SPA 已就绪）；
 *   - 命中软挑战（Cloudflare 中间页）时轮询等待自愈，避免误杀可自动通过的验证；
 *   - 超时后仍存在真实可见的挑战 widget / 拦截页，才按 challenge_required 中止并打印诊断。
 * 返回首次拿到的配额探针结果，供上层复用，避免二次请求。
 */
async function waitForDashboardReady(page, config) {
  const deadline = Date.now() + config.challengeWaitMs;
  let lastSignal = null;

  for (;;) {
    const currentUrl = page.url();
    if (/\/(login|register)(?:[/?#]|$)/i.test(currentUrl)) {
      throw new SharedChatClaimError('auth_failed', 'Cookie 已失效，页面已跳转到登录入口');
    }

    const probe = await fetchJsonInPage(page, QUOTA_PATH).catch(() => null);
    if (probe && probe.json && typeof probe.json === 'object') {
      return probe;
    }

    lastSignal = await detectChallengeSignal(page).catch(() => null);

    if (Date.now() >= deadline) {
      if (lastSignal?.blocked) {
        log(`验证拦截诊断: kind=${lastSignal.kind} ${lastSignal.detail} url=${lastSignal.url}`);
        throw new SharedChatClaimError(
          'challenge_required',
          `页面要求人工完成浏览器验证（${lastSignal.kind}）`
        );
      }
      log(`页面未就绪诊断: url=${currentUrl} title=${lastSignal?.title || ''}`);
      throw new SharedChatClaimError(
        'network_error',
        '页面加载后配额接口无有效响应，可能被前置验证或网络拦截'
      );
    }

    await page.waitForTimeout(CHALLENGE_POLL_INTERVAL_MS);
  }
}

async function clickClaimThroughUi(page, reason, timeoutMs) {
  const claimButton = page.getByRole('button', { name: '领取 Codex 权益', exact: true });
  try {
    await claimButton.waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    throw new SharedChatClaimError('schema_changed', '未找到可见的“领取 Codex 权益”按钮');
  }

  if (await claimButton.count() !== 1) {
    throw new SharedChatClaimError('schema_changed', '未找到唯一的“领取 Codex 权益”按钮');
  }

  await claimButton.click();

  const reasonInput = page.locator('.el-message-box textarea');
  await reasonInput.waitFor({ state: 'visible', timeout: timeoutMs });
  if (await reasonInput.count() !== 1) {
    throw new SharedChatClaimError('schema_changed', '领取原因输入框结构已变化');
  }
  await reasonInput.fill(reason);

  const confirmButton = page.locator('.el-message-box__btns button').filter({ hasText: '领取' });
  if (await confirmButton.count() !== 1) {
    throw new SharedChatClaimError('schema_changed', '领取确认按钮结构已变化');
  }

  const responsePromise = page.waitForResponse(
    response => response.url().includes(CLAIM_PATH) && response.request().method() === 'POST',
    { timeout: timeoutMs }
  );
  await confirmButton.click();

  let response;
  try {
    response = await responsePromise;
  } catch {
    throw new SharedChatClaimError(
      'challenge_required',
      '未捕获领取响应，浏览器指纹采集可能失败，请手动检查'
    );
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {}

  return analyzeClaimResponse(response.status(), payload);
}

async function waitForClaimActivation(page, dependencies = {}) {
  const fetchQuota = dependencies.fetchQuota || fetchJsonInPage;
  const wait = dependencies.wait || (delayMs => page.waitForTimeout(delayMs));
  const verificationAttempts = dependencies.verificationAttempts
    || CLAIM_VERIFICATION_ATTEMPTS;
  const verificationIntervalMs = dependencies.verificationIntervalMs
    || CLAIM_VERIFICATION_INTERVAL_MS;
  let quotaState = null;

  for (let attempt = 0; attempt < verificationAttempts; attempt += 1) {
    if (attempt > 0) await wait(verificationIntervalMs);

    const quota = await fetchQuota(page, QUOTA_PATH);
    quotaState = analyzeQuotaResponse(quota.status, quota.json);
    if (quotaState.type !== 'claimable') return quotaState;
  }

  return quotaState;
}

async function claimWithVerification(page, config, dependencies = {}) {
  const claim = dependencies.claim || clickClaimThroughUi;
  const logProgress = dependencies.log || log;
  const claimAttemptLimit = dependencies.claimAttemptLimit || CLAIM_ATTEMPT_LIMIT;

  for (let attempt = 1; attempt <= claimAttemptLimit; attempt += 1) {
    const claimResult = await claim(page, config.reason, config.timeoutMs);
    if (!['success', 'pending_verification'].includes(claimResult.type)) {
      return claimResult;
    }

    const verifiedState = await waitForClaimActivation(page, dependencies);
    if (verifiedState?.type === 'already_claimed') {
      return {
        type: 'success',
        message: claimResult.type === 'success' ? claimResult.message : '领取成功',
      };
    }
    if (verifiedState?.type !== 'claimable') return verifiedState;

    if (attempt < claimAttemptLimit) {
      logProgress('领取结果尚未生效，配额仍显示可领取，准备重试一次');
    }
  }

  return {
    type: 'api_error',
    message: '两次领取请求后配额仍未显示权益生效，请稍后重试',
  };
}

function formatResult(result) {
  if (result.type === 'success') {
    return `✅ ${result.message}`;
  }

  if (result.type === 'already_claimed') {
    const packageText = result.packageName ? `\n套餐: ${result.packageName}` : '';
    const resetText = result.resetTime
      ? `\n下次重置: ${new Date(result.resetTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
      : '';
    return `⏭️ ${result.message}${packageText}${resetText}`;
  }

  return `❌ 发生异常：${result.message}`;
}

async function runClaim(config) {
  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  };
  if (config.executablePath) launchOptions.executablePath = config.executablePath;

  let browser;
  let context;
  let page;

  try {
    browser = await chromium.launch(launchOptions);
    context = await browser.newContext({
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      viewport: { width: 1365, height: 900 },
      userAgent: config.userAgent,
    });

    // 反检测：抹除 headless 自动化特征，补齐真实 Chrome 运行时对象，降低触发人机验证概率
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      if (!window.chrome) {
        window.chrome = { runtime: {}, app: {}, csi: () => {}, loadTimes: () => {} };
      }
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
    });

    await context.addCookies(config.cookies);

    page = await context.newPage();
    page.setDefaultTimeout(config.timeoutMs);
    await page.goto(DASHBOARD_URL, {
      waitUntil: 'domcontentloaded',
      timeout: config.timeoutMs,
    });

    const quotaBefore = await waitForDashboardReady(page, config);
    const quotaState = analyzeQuotaResponse(quotaBefore.status, quotaBefore.json);
    if (quotaState.type !== 'claimable') return quotaState;

    log('当前未检测到生效权益，准备通过页面领取');
    // 必须 await：否则 runClaim 会立即返回并触发 finally 关闭浏览器，
    // 令仍在进行的领取流程（waitFor 按钮/接口）被中断并伪装成「未找到按钮」
    return await claimWithVerification(page, config);
  } catch (error) {
    if (error instanceof SharedChatClaimError) {
      return { type: error.type, message: error.message };
    }

    if (error?.name === 'TimeoutError' || /timeout/i.test(error?.message || '')) {
      return { type: 'network_error', message: '页面或接口请求超时' };
    }

    return { type: 'error', message: `执行失败: ${error?.message || String(error)}` };
  } finally {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

function printHelp() {
  console.log(`${TASK_TITLE}

用法:
  node sharedchat-vibe-claim.js

必填环境变量:
  SHAREDCHAT_COOKIE                  new.sharedchat.cc 的完整登录 Cookie

可选环境变量:
  SHAREDCHAT_CLAIM_REASON_PREFIX     领取原因前缀，脚本会追加北京时间日期
  SHAREDCHAT_TIMEOUT_MS              页面和接口超时毫秒数，默认 60000
  SHAREDCHAT_CHALLENGE_WAIT_MS       软验证自愈等待毫秒数，默认 15000
  SHAREDCHAT_USER_AGENT             浏览器 User-Agent，建议与获取 Cookie 时一致
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH  Chromium 可执行文件路径

青龙定时任务:
  5 0 * * * node /ql/data/scripts/sharedchat-vibe-claim.js

说明:
  脚本仅支持单账号。已内置基础反自动化检测（抹除 webdriver 特征等），
  并对可自动通过的软验证做自愈等待；若最终仍出现需人工点击的 Turnstile/
  Cloudflare 拦截，会停止并通知，不尝试破解验证码。`);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const rawCookie = process.env.SHAREDCHAT_COOKIE;
  if (!rawCookie?.trim()) {
    await notify(TASK_TITLE, '❌ 发生异常：未配置环境变量 SHAREDCHAT_COOKIE');
    process.exitCode = 1;
    return;
  }

  let config;
  try {
    config = {
      cookies: parseCookieHeader(rawCookie),
      executablePath: resolveChromiumExecutable(),
      timeoutMs: parsePositiveInteger(process.env.SHAREDCHAT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
      challengeWaitMs: parsePositiveInteger(
        process.env.SHAREDCHAT_CHALLENGE_WAIT_MS,
        DEFAULT_CHALLENGE_WAIT_MS
      ),
      userAgent: process.env.SHAREDCHAT_USER_AGENT?.trim() || DEFAULT_USER_AGENT,
      reason: buildClaimReason(process.env.SHAREDCHAT_CLAIM_REASON_PREFIX),
    };
  } catch (error) {
    await notify(TASK_TITLE, `❌ 发生异常：${error.message}`);
    process.exitCode = 1;
    return;
  }

  log(`开始检查每日权益 - ${shanghaiDateStamp()}`);
  const result = await runClaim(config);
  await notify(TASK_TITLE, formatResult(result));

  if (result.type !== 'success' && result.type !== 'already_claimed') {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(async (error) => {
    await notify(TASK_TITLE, `❌ 发生异常：执行异常: ${error.message || String(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  SharedChatClaimError,
  analyzeClaimResponse,
  analyzeQuotaResponse,
  buildClaimReason,
  claimWithVerification,
  detectChallengeSignal,
  formatResult,
  getCodexQuota,
  isAlreadyClaimedMessage,
  isSuccessMessage,
  normalizeCookie,
  parseCookieHeader,
  parsePositiveInteger,
  resolveChromiumExecutable,
  runClaim,
  shanghaiDateStamp,
  waitForDashboardReady,
  waitForClaimActivation,
};
