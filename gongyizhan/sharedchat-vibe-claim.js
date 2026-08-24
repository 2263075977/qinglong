#!/usr/bin/env node
/**
 * cron: 5 0 * * *
 * new Env('SharedChat Vibe Code 权益领取');
 *
 * 必填环境变量:
 *   SHAREDCHAT_USERNAME="用户名或邮箱"
 *   SHAREDCHAT_PASSWORD="登录密码"
 *
 * 可选环境变量:
 *   SHAREDCHAT_CLAIM_REASON_PREFIX="用于学习 Codex 编程并完成个人项目"
 *   SHAREDCHAT_TIMEOUT_MS=60000
 *   SHAREDCHAT_CHALLENGE_WAIT_MS=15000
 *   SHAREDCHAT_USER_AGENT="浏览器 User-Agent"
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
 */

'use strict';

const fs = require('node:fs');
const { chromium } = require('playwright');

const SITE_URL = 'https://new.sharedchat.cc';
const SITE_ORIGIN = new URL(SITE_URL).origin;
const LOGIN_URL = `${SITE_URL}/list/#/login`;
const DASHBOARD_URL = `${SITE_URL}/list/#/vibe-code/dashboard`;
const LOGIN_CONFIG_PATH = '/frontend-api/getLoginConfig';
const LOGIN_PATH = '/frontend-api/login';
const LOGIN_STORAGE_KEY = '__user_token__';
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

// 诊断辅助函数
let sessionStartTime = null;

function logWithTimestamp(message, startTime = null) {
  if (!sessionStartTime) sessionStartTime = Date.now();
  const elapsed = Date.now() - (startTime || sessionStartTime);
  log(`[+${elapsed}ms] ${message}`);
}

async function captureDebugScreenshot(page, step) {
  try {
    const debugDir = './debug';
    if (!fs.existsSync(debugDir)) {
      fs.mkdirSync(debugDir, { recursive: true });
    }
    const timestamp = Date.now();
    const filename = `${debugDir}/sharedchat-timeout-${timestamp}-${step}.png`;
    await page.screenshot({ path: filename, fullPage: true });
    log(`调试截图已保存: ${filename}`);
    return filename;
  } catch (error) {
    log(`截图失败: ${error.message}`);
    return null;
  }
}

async function capturePageContext(page) {
  try {
    return await page.evaluate(() => ({
      url: `${location.origin}${location.pathname}`,
      title: document.title,
      readyState: document.readyState,
    }));
  } catch {
    return null;
  }
}

function parsePositiveInteger(value, fallback) {
  const number = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function safePageUrl(value) {
  try {
    const parsed = new URL(String(value));
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '';
  }
}

function getConfig(env = process.env) {
  const username = String(env?.SHAREDCHAT_USERNAME || '').trim();
  if (!username) {
    throw new SharedChatClaimError('config_error', '未配置环境变量 SHAREDCHAT_USERNAME');
  }

  const password = String(env?.SHAREDCHAT_PASSWORD || '');
  if (!password.trim()) {
    throw new SharedChatClaimError('config_error', '未配置环境变量 SHAREDCHAT_PASSWORD');
  }

  return {
    username,
    password,
    executablePath: resolveChromiumExecutable(env?.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH),
    timeoutMs: parsePositiveInteger(env?.SHAREDCHAT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    challengeWaitMs: parsePositiveInteger(
      env?.SHAREDCHAT_CHALLENGE_WAIT_MS,
      DEFAULT_CHALLENGE_WAIT_MS
    ),
    userAgent: String(env?.SHAREDCHAT_USER_AGENT || '').trim() || DEFAULT_USER_AGENT,
    reason: buildClaimReason(env?.SHAREDCHAT_CLAIM_REASON_PREFIX),
  };
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
    || text.includes('invalid credential')
    || text.includes('invalid token')
    || text.includes('token invalid')
    || text.includes('user not found')
    || text.includes('wrong password')
    || text.includes('login failed')
    || text.includes('invalid username')
    || text.includes('invalid password')
    || text.includes('not login')
    || text.includes('not logged')
    || text.includes('expired')
    || text.includes('未登录')
    || text.includes('登录失效')
    || text.includes('登录状态过期')
    || text.includes('账号或密码')
    || text.includes('用户名或密码')
    || text.includes('密码错误')
    || text.includes('账号不存在')
    || text.includes('用户不存在')
    || text.includes('登录失败')
    || text.includes('重新登录')
    || text.includes('请登录')
    || text.includes('无权限');
}

function isChallengeMessage(message) {
  const text = String(message || '').toLowerCase();
  return text.includes('turnstile')
    || text.includes('cloudflare')
    || text.includes('captcha')
    || text.includes('人机验证')
    || text.includes('安全验证')
    || text.includes('安全检查')
    || text.includes('验证码')
    || text.includes('challenge required')
    || text.includes('human verification');
}

function isLoginPageUrl(url) {
  return /\/(login|register)(?:[/?#]|$)/i.test(String(url || ''));
}

function isSiteApiResponse(response, path, method = 'POST') {
  try {
    const parsed = new URL(response.url());
    return parsed.origin === SITE_ORIGIN
      && parsed.pathname === path
      && response.request().method() === method;
  } catch {
    return false;
  }
}

function analyzeLoginResponse(status, payload) {
  const message = extractMessage(payload);

  if (status === 0 || status === 408 || status === 429 || status >= 500) {
    return { type: 'network_error', message: '登录请求失败或服务暂时不可用' };
  }

  if (isChallengeMessage(message)
    || payload?.challenge_required === true
    || payload?.data?.challenge_required === true
    || payload?.data?.requiresChallenge === true) {
    return {
      type: 'challenge_required',
      message: '登录需要人工完成 Turnstile/Cloudflare 验证',
    };
  }

  if (status === 401 || status === 403 || isAuthMessage(message)) {
    return {
      type: 'auth_failed',
      message: '账号或密码错误或登录状态无效',
    };
  }

  if (!payload || typeof payload !== 'object' || !Object.prototype.hasOwnProperty.call(payload, 'code')) {
    return { type: 'schema_changed', message: '登录接口响应结构已变化' };
  }

  if (status >= 200 && status < 300 && payload.code === 1) {
    return { type: 'success', message: '登录成功' };
  }

  return { type: 'schema_changed', message: '登录接口响应结构已变化' };
}

function getLoginConfig(payload) {
  if (!payload || typeof payload !== 'object' || payload.code !== 1
    || !payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
    return null;
  }

  const enabled = payload.data.isEnableLoginTurnstile;
  if (typeof enabled !== 'boolean') return null;

  return {
    turnstileEnabled: enabled,
    turnstileSiteKey: typeof payload.data.turnstileSiteKey === 'string'
      ? payload.data.turnstileSiteKey.trim()
      : '',
  };
}

async function loginWithCredentials(page, config, dependencies = {}) {
  const fetchPageJson = dependencies.fetchJson || fetchJsonInPage;
  const detectChallenge = dependencies.detectChallenge || detectChallengeSignal;
  const startTime = Date.now();

  try {
    await page.goto(LOGIN_URL, {
      waitUntil: 'domcontentloaded',
      timeout: config.timeoutMs,
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || /timeout/i.test(error?.message || '')) {
      throw new SharedChatClaimError('network_error', '登录页面加载超时，请检查网络连接');
    }
    throw new SharedChatClaimError('network_error', '登录页面加载失败，请检查网络连接');
  }

  const initialChallenge = await detectChallenge(page).catch(() => null);
  if (initialChallenge?.blocked) {
    throw new SharedChatClaimError(
      'challenge_required',
      '登录需要人工完成 Turnstile/Cloudflare 验证，请在网页中手动处理'
    );
  }

  const loginConfigProbe = await fetchPageJson(page, LOGIN_CONFIG_PATH);
  if (loginConfigProbe.status === 0) {
    throw new SharedChatClaimError('network_error', '登录配置接口请求失败，请检查网络连接');
  }
  if (loginConfigProbe.status === 401 || loginConfigProbe.status === 403) {
    const challenge = await detectChallenge(page).catch(() => null);
    if (challenge?.blocked) {
      throw new SharedChatClaimError(
        'challenge_required',
        '登录需要人工完成 Turnstile/Cloudflare 验证，请在网页中手动处理'
      );
    }
    throw new SharedChatClaimError('auth_failed', '登录配置接口拒绝访问');
  }
  if (loginConfigProbe.status < 200 || loginConfigProbe.status >= 300) {
    throw new SharedChatClaimError('network_error', '登录配置接口暂时不可用');
  }
  const loginConfig = getLoginConfig(loginConfigProbe?.json);
  if (!loginConfig) {
    const challenge = await detectChallenge(page).catch(() => null);
    if (challenge?.blocked) {
      throw new SharedChatClaimError(
        'challenge_required',
        '登录需要人工完成 Turnstile/Cloudflare 验证，请在网页中手动处理'
      );
    }
    throw new SharedChatClaimError('schema_changed', '登录配置接口响应结构已变化');
  }
  if (loginConfig.turnstileEnabled) {
    throw new SharedChatClaimError(
      'challenge_required',
      '登录需要人工完成 Turnstile/Cloudflare 验证，请在网页中手动处理'
    );
  }

  const usernameInputs = page.locator(
    'input:not([type]), input[type="text"], input[type="email"]'
  );
  const passwordInputs = page.locator('input[type="password"]');
  try {
    await usernameInputs.nth(0).waitFor({ state: 'visible', timeout: config.timeoutMs });
    await passwordInputs.nth(0).waitFor({ state: 'visible', timeout: config.timeoutMs });
  } catch (error) {
    if (error?.name === 'TimeoutError' || /timeout/i.test(error?.message || '')) {
      throw new SharedChatClaimError('schema_changed', '登录表单结构已变化');
    }
    throw new SharedChatClaimError('schema_changed', '登录表单不可用');
  }

  const usernameCount = await usernameInputs.count();
  const passwordCount = await passwordInputs.count();
  if (usernameCount !== 1 || passwordCount !== 1) {
    throw new SharedChatClaimError('schema_changed', '登录表单字段结构已变化');
  }

  const usernameInput = usernameInputs.nth(0);
  const passwordInput = passwordInputs.nth(0);

  try {
    await usernameInput.fill(config.username);
    await passwordInput.fill(config.password);
  } catch {
    throw new SharedChatClaimError('schema_changed', '登录表单字段不可填写');
  }

  const formChallenge = await detectChallenge(page).catch(() => null);
  if (formChallenge?.blocked) {
    throw new SharedChatClaimError(
      'challenge_required',
      '登录需要人工完成 Turnstile/Cloudflare 验证，请在网页中手动处理'
    );
  }

  const submitButtons = page.getByRole('button', { name: /登录|login/i });
  try {
    await submitButtons.nth(0).waitFor({ state: 'visible', timeout: config.timeoutMs });
  } catch (error) {
    if (error?.name === 'TimeoutError' || /timeout/i.test(error?.message || '')) {
      throw new SharedChatClaimError('schema_changed', '登录按钮结构已变化');
    }
    throw new SharedChatClaimError('schema_changed', '登录按钮不可用');
  }

  const submitCount = await submitButtons.count();
  if (submitCount !== 1) {
    throw new SharedChatClaimError('schema_changed', '未找到唯一的登录按钮');
  }
  const submitButton = submitButtons.nth(0);

  let response;
  try {
    [response] = await Promise.all([
      page.waitForResponse(
        loginResponse => isSiteApiResponse(loginResponse, LOGIN_PATH),
        { timeout: config.timeoutMs }
      ),
      submitButton.click(),
    ]);
  } catch (error) {
    const challenge = await detectChallenge(page).catch(() => null);
    if (challenge?.blocked) {
      throw new SharedChatClaimError(
        'challenge_required',
        '登录需要人工完成 Turnstile/Cloudflare 验证，请在网页中手动处理'
      );
    }
    if (error?.name === 'TimeoutError' || /timeout/i.test(error?.message || '')) {
      throw new SharedChatClaimError('network_error', '登录请求超时，请检查网络连接');
    }
    throw new SharedChatClaimError('network_error', '登录请求失败，请检查网络连接');
  }

  const responseStatus = response.status();
  if (responseStatus === 0 || responseStatus === 408 || responseStatus === 429
    || responseStatus >= 500) {
    throw new SharedChatClaimError('network_error', '登录请求失败或服务暂时不可用');
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    const challenge = await detectChallenge(page).catch(() => null);
    if (challenge?.blocked) {
      throw new SharedChatClaimError(
        'challenge_required',
        '登录需要人工完成 Turnstile/Cloudflare 验证，请在网页中手动处理'
      );
    }
    if (responseStatus === 401 || responseStatus === 403) {
      throw new SharedChatClaimError('auth_failed', '账号或密码错误或登录状态无效');
    }
    throw new SharedChatClaimError('schema_changed', '登录接口未返回有效 JSON');
  }

  if (responseStatus === 401 || responseStatus === 403) {
    const result = analyzeLoginResponse(responseStatus, payload);
    if (result.type === 'challenge_required') {
      throw new SharedChatClaimError(result.type, result.message);
    }
    throw new SharedChatClaimError('auth_failed', '账号或密码错误或登录状态无效');
  }

  const result = analyzeLoginResponse(responseStatus, payload);
  if (result.type !== 'success') {
    throw new SharedChatClaimError(result.type, result.message);
  }

  // 站点登录页在成功回调中写入这个会话标记；这里显式补齐，避免
  // 在响应事件与前端 Promise 回调之间直接导航导致 SPA 误判为未登录。
  try {
    await page.evaluate((storageKey) => {
      window.localStorage.setItem(storageKey, 'token');
    }, LOGIN_STORAGE_KEY);
  } catch {
    throw new SharedChatClaimError('browser_error', '登录成功后无法建立页面会话');
  }

  try {
    await page.goto(DASHBOARD_URL, {
      waitUntil: 'domcontentloaded',
      timeout: config.timeoutMs,
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || /timeout/i.test(error?.message || '')) {
      throw new SharedChatClaimError('network_error', '登录成功后打开权益页面超时');
    }
    throw new SharedChatClaimError('network_error', '登录成功后打开权益页面失败');
  }

  const finalUrl = page.url();
  if (isLoginPageUrl(finalUrl)) {
    throw new SharedChatClaimError('auth_failed', '账号或密码错误或登录状态无效');
  }

  const finalChallenge = await detectChallenge(page).catch(() => null);
  if (finalChallenge?.blocked) {
    throw new SharedChatClaimError(
      'challenge_required',
      '登录后页面需要人工完成 Turnstile/Cloudflare 验证'
    );
  }

  logWithTimestamp(`登录完成（HTTP ${responseStatus}，页面已进入权益入口）`, startTime);
  return { type: 'success', message: '登录成功' };
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
    return { type: 'auth_failed', message: '登录状态无效，请重新登录' };
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
    return { type: 'auth_failed', message: '登录状态无效，请重新登录' };
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

  // 服务端顶层可能返回 code:1 + msg:"success"（表示请求被受理），但 data 里明确标记失败：
  // claimed:false 且带详细 message（如"登录状态过期"）。此时应采信 data 的结论，不能被顶层假成功骗过去。
  if (payload.code === 1 && data && typeof data === 'object' && data.claimed === false) {
    const dataMessage = typeof data.message === 'string' ? data.message.trim() : '';
    if (dataMessage) {
      if (isAuthMessage(dataMessage)) {
        return { type: 'auth_failed', message: '登录状态无效，请重新登录' };
      }
      if (isAlreadyClaimedMessage(dataMessage)) {
        return { type: 'already_claimed', message: dataMessage };
      }
      // 其他明确的失败原因
      return { type: 'error', message: dataMessage };
    }
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
      let parseError = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch (err) {
        parseError = err.message;
      }
      return {
        ok: response.ok,
        status: response.status,
        json,
        textLength: text ? text.length : 0,
        parseError,
      };
    } catch (error) {
      return { ok: false, status: 0, json: null, networkError: error.message || String(error) };
    }
  }, { requestPath: path, requestOptions: options });

  if (result.networkError) {
    throw new SharedChatClaimError('network_error', `请求站点接口失败: ${result.networkError}`);
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
      url: `${location.origin}${location.pathname}`,
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
        // 不记录 iframe src：Cloudflare/Turnstile 的 URL 可能携带动态挑战参数。
        signal.detail = `visible <${el.tagName.toLowerCase()}> `
          + `${el.className || el.id || 'challenge-widget'}`.trim();
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
 *   - 优先通过 DOM 可见性判断页面就绪（领取按钮可见表示 SPA 已渲染完成）；
 *   - 配额接口作为次要验证，若接口失败但页面内容已就绪，仍可继续；
 *   - 命中软挑战（Cloudflare 中间页）时轮询等待自愈，避免误杀可自动通过的验证；
 *   - 超时后仍存在真实可见的挑战 widget / 拦截页，才按 challenge_required 中止并打印诊断。
 * 返回首次拿到的配额探针结果（可能为 null），供上层复用。
 */
async function waitForDashboardReady(page, config) {
  const deadline = Date.now() + config.challengeWaitMs;
  const startTime = Date.now();
  let lastSignal = null;
  let attemptCount = 0;
  let quotaProbe = null;

  for (;;) {
    attemptCount++;
    const currentUrl = page.url();
    logWithTimestamp(
      `Dashboard 就绪检测 #${attemptCount}: ${safePageUrl(currentUrl)}`,
      startTime
    );

    if (/\/(login|register)(?:[/?#]|$)/i.test(currentUrl)) {
      throw new SharedChatClaimError('auth_failed', '登录状态无效，页面已跳转到登录入口');
    }

    // 检测页面 DOM 是否已就绪（领取按钮可见 = SPA 已渲染）
    const isDomReady = await page.evaluate(() => {
      const button = document.querySelector('button');
      if (!button) return false;
      const buttonText = button.textContent || '';
      return buttonText.includes('领取') && buttonText.includes('Codex');
    }).catch(() => false);

    logWithTimestamp(`DOM 就绪状态: ${isDomReady}`, startTime);

    // 尝试调用配额接口
    const probe = await fetchJsonInPage(page, QUOTA_PATH).catch(err => {
      logWithTimestamp(`配额接口调用异常: ${err.message}`, startTime);
      return null;
    });

    if (probe) {
      logWithTimestamp(
        `配额探测 #${attemptCount}: ok=${probe.ok} status=${probe.status} ` +
        `hasJson=${!!probe.json} jsonType=${typeof probe.json} ` +
        `textLen=${probe.textLength || 0} ` +
        `parseError=${probe.parseError ? 'yes' : 'none'}`,
        startTime
      );

      if (probe.status === 401 || probe.status === 403) {
        const signal = await detectChallengeSignal(page).catch(() => null);
        if (signal?.blocked) {
          throw new SharedChatClaimError(
            'challenge_required',
            `页面要求人工完成浏览器验证（${signal.kind}）`
          );
        }
        throw new SharedChatClaimError('auth_failed', '登录状态无效，请重新登录');
      }

      if (probe.json && typeof probe.json === 'object') {
        logWithTimestamp(`Dashboard 已就绪（配额接口验证通过）`, startTime);
        return probe;
      }

      // 保存第一次成功的 HTTP 响应（即使 JSON 解析失败），供后续诊断
      if (!quotaProbe && probe.status >= 200 && probe.status < 300) {
        quotaProbe = probe;
      }
    }

    // 如果 DOM 已就绪但配额接口失败，先尝试几次，若持续失败则认为页面可用
    if (isDomReady) {
      if (attemptCount >= 3) {
        logWithTimestamp(
          `Dashboard DOM 已就绪，配额接口响应异常但不阻断流程`,
          startTime
        );
        return quotaProbe || { ok: false, status: 0, json: null };
      }
      logWithTimestamp(`DOM 已就绪，再验证配额接口 ${3 - attemptCount} 次`, startTime);
    }

    lastSignal = await detectChallengeSignal(page).catch(() => null);

    if (Date.now() >= deadline) {
      const screenshot = await captureDebugScreenshot(page, 'dashboard-timeout');
      log(`Dashboard 就绪超时，尝试次数: ${attemptCount}，截图: ${screenshot}`);
      if (lastSignal?.blocked) {
        log(`验证拦截诊断: kind=${lastSignal.kind} ${lastSignal.detail}`);
        throw new SharedChatClaimError(
          'challenge_required',
          `页面要求人工完成浏览器验证（${lastSignal.kind}）`
        );
      }
      log(`页面未就绪诊断: url=${safePageUrl(currentUrl)} title=${lastSignal?.title || ''}`);
      throw new SharedChatClaimError(
        'network_error',
        '页面加载后配额接口无有效响应，可能被前置验证或网络拦截'
      );
    }

    await page.waitForTimeout(CHALLENGE_POLL_INTERVAL_MS);
  }
}

async function clickClaimThroughUi(page, reason, timeoutMs) {
  const stepStartTime = Date.now();
  logWithTimestamp('开始领取流程', stepStartTime);

  logWithTimestamp('等待【领取 Codex 权益】按钮可见...', stepStartTime);
  const claimButton = page.getByRole('button', { name: '领取 Codex 权益', exact: true });
  try {
    await claimButton.waitFor({ state: 'visible', timeout: timeoutMs });
    logWithTimestamp('按钮已可见', stepStartTime);
  } catch (error) {
    const screenshot = await captureDebugScreenshot(page, 'wait-button');
    const context = await capturePageContext(page);
    log(`页面上下文: ${JSON.stringify(context)}`);
    throw new SharedChatClaimError(
      'schema_changed',
      `等待【领取按钮】超时 (${Date.now() - stepStartTime}ms)，截图: ${screenshot}`
    );
  }

  if (await claimButton.count() !== 1) {
    throw new SharedChatClaimError('schema_changed', '未找到唯一的”领取 Codex 权益”按钮');
  }

  logWithTimestamp('点击领取按钮', stepStartTime);
  try {
    await claimButton.click();
  } catch (clickError) {
    // click 可能因为页面跳转而失败
    const currentUrl = page.url();
    if (/\/(login|register)(?:[/?#]|$)/i.test(currentUrl)) {
      const screenshot = await captureDebugScreenshot(page, 'auth-redirect-on-click');
      throw new SharedChatClaimError(
        'auth_failed',
        `登录状态无效，点击领取按钮时页面跳转到登录入口，截图: ${screenshot}`
      );
    }
    // 不是登录跳转，重新抛出原错误
    throw clickError;
  }

  logWithTimestamp('等待领取原因输入框...', stepStartTime);
  const reasonInput = page.locator('.el-message-box textarea');
  try {
    await reasonInput.waitFor({ state: 'visible', timeout: timeoutMs });
    logWithTimestamp('输入框已可见', stepStartTime);
  } catch (error) {
    // 优先检测是否因登录失效而跳转
    const currentUrl = page.url();
    if (/\/(login|register)(?:[/?#]|$)/i.test(currentUrl)) {
      const screenshot = await captureDebugScreenshot(page, 'auth-redirect');
      throw new SharedChatClaimError(
        'auth_failed',
        `登录状态无效，点击领取按钮后页面跳转到登录入口 (${Date.now() - stepStartTime}ms)，截图: ${screenshot}`
      );
    }
    // 不是登录跳转，才按原有逻辑处理
    const screenshot = await captureDebugScreenshot(page, 'wait-textarea');
    const context = await capturePageContext(page);
    log(`页面上下文: ${JSON.stringify(context)}`);
    throw new SharedChatClaimError(
      'schema_changed',
      `等待【输入框】超时 (${Date.now() - stepStartTime}ms)，截图: ${screenshot}`
    );
  }

  if (await reasonInput.count() !== 1) {
    throw new SharedChatClaimError('schema_changed', '领取原因输入框结构已变化');
  }

  logWithTimestamp('填写领取原因', stepStartTime);
  await reasonInput.fill(reason);

  logWithTimestamp('查找确认按钮', stepStartTime);
  const confirmButton = page.locator('.el-message-box__btns button').filter({ hasText: '领取' });
  if (await confirmButton.count() !== 1) {
    throw new SharedChatClaimError('schema_changed', '领取确认按钮结构已变化');
  }

  logWithTimestamp('点击确认按钮并等待响应...', stepStartTime);
  const responsePromise = page.waitForResponse(
    response => isSiteApiResponse(response, CLAIM_PATH),
    { timeout: timeoutMs }
  );
  await confirmButton.click();

  let response;
  try {
    response = await responsePromise;
    logWithTimestamp(`收到领取响应: HTTP ${response.status()}`, stepStartTime);
  } catch (error) {
    if (isLoginPageUrl(page.url())) {
      throw new SharedChatClaimError(
        'auth_failed',
        '登录状态无效，领取请求后页面跳转到登录入口'
      );
    }
    const challenge = await detectChallengeSignal(page).catch(() => null);
    if (challenge?.blocked) {
      throw new SharedChatClaimError(
        'challenge_required',
        `页面要求人工完成浏览器验证（${challenge.kind}）`
      );
    }
    const screenshot = await captureDebugScreenshot(page, 'wait-response');
    const context = await capturePageContext(page);
    log(`页面上下文: ${JSON.stringify(context)}`);
    throw new SharedChatClaimError(
      'network_error',
      `等待【POST 响应】超时 (${Date.now() - stepStartTime}ms)，截图: ${screenshot}`
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

    // 领取接口已用 claimed:true 权威确认领取成功（analyzeClaimResponse 映射为 success），
    // 直接采信返回。不再用配额接口二次确认：配额存在同步延迟，此刻仍可能显示 claimable，
    // 若据此误判「未生效」并重试，会撞上首次领取已作废的 session 而误报失败。
    // 仅当响应不明确（success=true 但缺少 claimed 字段，即 pending_verification）时，
    // 才继续用配额接口兜底确认。
    if (claimResult.type !== 'pending_verification') {
      return claimResult;
    }

    const verifiedState = await waitForClaimActivation(page, dependencies);
    if (verifiedState?.type === 'already_claimed') {
      return { type: 'success', message: '领取成功' };
    }
    if (verifiedState?.type !== 'claimable') return verifiedState;

    if (attempt < claimAttemptLimit) {
      logProgress('领取结果尚未生效，配额仍显示可领取，准备重试一次');

      // 重试前检测登录状态，避免在失效的 session 上浪费时间
      const currentUrl = page.url();
      if (/\/(login|register)(?:[/?#]|$)/i.test(currentUrl)) {
        return {
          type: 'auth_failed',
          message: '登录状态在领取后失效，页面已跳转到登录入口',
        };
      }
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
  sessionStartTime = Date.now();  // 重置诊断时间基准
  logWithTimestamp('runClaim 开始');

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

    page = await context.newPage();
    page.setDefaultTimeout(config.timeoutMs);
    log('正在使用账号密码登录');
    await loginWithCredentials(page, config);

    const quotaBefore = await waitForDashboardReady(page, config);

    // 如果配额接口返回了有效数据，检查是否已领取
    if (quotaBefore && quotaBefore.json && typeof quotaBefore.json === 'object') {
      const quotaState = analyzeQuotaResponse(quotaBefore.status, quotaBefore.json);
      if (quotaState.type !== 'claimable') {
        return quotaState;
      }
      log('配额接口确认：当前未检测到生效权益');
    } else {
      log('配额接口响应异常，但页面已就绪，将尝试通过 UI 领取');
    }

    log('准备通过页面领取');
    // 必须 await：否则 runClaim 会立即返回并触发 finally 关闭浏览器，
    // 令仍在进行的领取流程（waitFor 按钮/接口）被中断并伪装成「未找到按钮」
    return await claimWithVerification(page, config);
  } catch (error) {
    if (error instanceof SharedChatClaimError) {
      return { type: error.type, message: error.message };
    }

    // 通用超时错误处理
    if (error?.name === 'TimeoutError' || /timeout/i.test(error?.message || '')) {
      let screenshotPath = null;
      if (page) {
        screenshotPath = await captureDebugScreenshot(page, 'general-timeout');
        const context = await capturePageContext(page);
        log(`通用超时上下文: ${JSON.stringify(context)}`);

        // 登录态失效时页面会跳转到登录 SPA；按最终落点保留 auth_failed 分类。
        if (/\/(login|register)(?:[/?#]|$)/i.test(page.url())) {
          return { type: 'auth_failed', message: '登录状态无效，页面已跳转到登录入口' };
        }
      }
      return {
        type: 'network_error',
        message: `页面或接口请求超时，截图: ${screenshotPath}`
      };
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
  SHAREDCHAT_USERNAME                SharedChat 用户名或邮箱
  SHAREDCHAT_PASSWORD                SharedChat 登录密码

可选环境变量:
  SHAREDCHAT_CLAIM_REASON_PREFIX     领取原因前缀，脚本会追加北京时间日期
  SHAREDCHAT_TIMEOUT_MS              页面和接口超时毫秒数，默认 60000
  SHAREDCHAT_CHALLENGE_WAIT_MS       软验证自愈等待毫秒数，默认 15000
  SHAREDCHAT_USER_AGENT             浏览器 User-Agent
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH  Chromium 可执行文件路径

青龙定时任务:
  5 0 * * * node /ql/data/scripts/sharedchat-vibe-claim.js

说明:
  脚本仅支持单账号，每次运行在临时浏览器上下文中登录，不持久化会话。
  已内置基础反自动化检测（抹除 webdriver 特征等），
  并对可自动通过的软验证做自愈等待；若最终仍出现需人工点击的 Turnstile/
  Cloudflare 拦截，会停止并通知，不尝试破解验证码。`);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  let config;
  try {
    config = getConfig(process.env);
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
  analyzeLoginResponse,
  analyzeQuotaResponse,
  buildClaimReason,
  claimWithVerification,
  detectChallengeSignal,
  formatResult,
  getConfig,
  getCodexQuota,
  isAlreadyClaimedMessage,
  isSuccessMessage,
  loginWithCredentials,
  parsePositiveInteger,
  resolveChromiumExecutable,
  runClaim,
  shanghaiDateStamp,
  waitForDashboardReady,
  waitForClaimActivation,
};
