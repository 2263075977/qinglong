'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  formatResult,
  installApiUserHeader,
  isAuthMessage,
  isChallengeVisible,
  parseBoolean,
  parseCookieHeader,
  sanitizeTraceUrl,
  verifySession,
} = require('./runanytime-browser');

test('Cookie 与布尔配置解析保持兼容', () => {
  assert.deepEqual(
    parseCookieHeader('session=abc==; theme=dark').map(({ name, value }) => [name, value]),
    [['session', 'abc=='], ['theme', 'dark']]
  );
  for (const value of ['1', 'true', 'yes', 'on']) assert.equal(parseBoolean(value, false), true);
  for (const value of ['0', 'false', 'no', 'off']) assert.equal(parseBoolean(value, true), false);
});

test('明确的中英文登录失效消息均归类为鉴权失败', async () => {
  for (const message of [
    'Unauthorized',
    'not logged in',
    'Please login first',
    'Token expired',
    '登录已失效',
    '请先登录',
    '登录过期',
    '无权限',
  ]) {
    assert.equal(isAuthMessage(message), true, message);
    const page = {
      evaluate: async () => ({ authenticated: false, message, status: 200 }),
    };
    assert.equal((await verifySession(page)).authFailed, true, message);
  }
});

test('请求跟踪隐藏验证参数并忽略无关来源', () => {
  assert.equal(
    sanitizeTraceUrl(
      'https://runanytime.hxi.me/api/user/checkin?turnstile=secret&pow_challenge=abc&pow_nonce=42'
    ),
    'https://runanytime.hxi.me/api/user/checkin?turnstile=<redacted>&pow_challenge=<redacted>&pow_nonce=<redacted>'
  );
  assert.equal(
    sanitizeTraceUrl('https://challenges.cloudflare.com/turnstile/v0/api.js?token=secret'),
    'https://challenges.cloudflare.com/turnstile/v0/api.js'
  );
  assert.equal(sanitizeTraceUrl('https://example.com/api/user/checkin?token=secret'), null);
  assert.equal(sanitizeTraceUrl('https://runanytime.hxi.me/static/app.js?token=secret'), null);
});

test('New-Api-User 只注册到 RunAnytime API 路由', async () => {
  let pattern;
  let handler;
  const context = {
    route: async (nextPattern, nextHandler) => {
      pattern = nextPattern;
      handler = nextHandler;
    },
  };

  await installApiUserHeader(context, '8514');
  assert.equal(pattern, 'https://runanytime.hxi.me/api/**');

  let continuedHeaders;
  await handler({
    request: () => ({
      headers: () => ({ Accept: 'application/json', 'New-Api-User': 'old-value' }),
    }),
    continue: async ({ headers }) => {
      continuedHeaders = headers;
    },
  });
  assert.equal(continuedHeaders['new-api-user'], '8514');
  assert.equal(Object.keys(continuedHeaders).filter(key => key.toLowerCase() === 'new-api-user').length, 1);
});

test('初始安全验证元素可被识别', async () => {
  const page = {
    getByText: text => ({ count: async () => text === 'Security Check' ? 1 : 0 }),
    locator: () => ({ count: async () => 0 }),
  };
  assert.equal(await isChallengeVisible(page), true);
});

test('通知格式保留异常路由标记', () => {
  assert.match(
    formatResult({ type: 'challenge_required', message: '需要验证' }),
    /发生异常/
  );
  assert.doesNotMatch(
    formatResult({ type: 'already_checked', message: '今日已签到' }),
    /发生异常/
  );
});
