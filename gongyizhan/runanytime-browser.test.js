'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { chromium } = require('playwright');
const {
  RunAnytimeBrowserError,
  buildCheckinPath,
  formatTurnstileFailure,
  isTurnstileMessage,
  requestTurnstileToken,
  resolveChromiumExecutable,
  sanitizeTraceUrl,
  submitPowProof,
} = require('./runanytime-browser');

let browser;

before(async () => {
  const executablePath = resolveChromiumExecutable();
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
});

after(async () => {
  await browser?.close();
});

test('buildCheckinPath adds Turnstile only for the fallback request', () => {
  const proof = { challengeId: 'challenge-sentinel', nonce: 'nonce-sentinel' };
  const first = new URL(buildCheckinPath(proof), 'https://runanytime.hxi.me');
  const fallback = new URL(
    buildCheckinPath(proof, 'turnstile-sentinel'),
    'https://runanytime.hxi.me'
  );

  assert.equal(first.searchParams.get('turnstile'), null);
  assert.equal(first.searchParams.get('pow_challenge'), proof.challengeId);
  assert.equal(first.searchParams.get('pow_nonce'), proof.nonce);
  assert.equal(fallback.searchParams.get('turnstile'), 'turnstile-sentinel');
  assert.equal(fallback.searchParams.get('pow_challenge'), proof.challengeId);
  assert.equal(fallback.searchParams.get('pow_nonce'), proof.nonce);
  assert.throws(
    () => buildCheckinPath({ challengeId: 'challenge-sentinel', nonce: '' }),
    error => error instanceof RunAnytimeBrowserError && error.type === 'schema_changed'
  );
});

test('submitPowProof reuses the supplied proof without exposing it in the result', async () => {
  let submittedPath = '';
  const page = {
    evaluate: async (_callback, path) => {
      submittedPath = path;
      return {
        stage: 'submit',
        status: 200,
        success: true,
        message: '',
        data: { quota_awarded: 1 },
      };
    },
  };
  const proof = { challengeId: 'same-challenge', nonce: 'same-nonce' };

  const result = await submitPowProof(page, proof, 'verified-token');
  const url = new URL(submittedPath, 'https://runanytime.hxi.me');

  assert.equal(url.searchParams.get('turnstile'), 'verified-token');
  assert.equal(url.searchParams.get('pow_challenge'), proof.challengeId);
  assert.equal(url.searchParams.get('pow_nonce'), proof.nonce);
  assert.equal(result.success, true);
  assert.equal(JSON.stringify(result).includes('verified-token'), false);
});

test('Turnstile classification requires a concrete Turnstile signal', () => {
  assert.equal(isTurnstileMessage('Turnstile token 为空'), true);
  assert.equal(isTurnstileMessage('需要人机验证'), true);
  assert.equal(isTurnstileMessage('PoW 验证失败'), false);
  assert.equal(isTurnstileMessage('参数验证失败'), false);
});

test('sanitizeTraceUrl redacts API secrets and all Cloudflare challenge paths', () => {
  const apiUrl = sanitizeTraceUrl(
    'https://runanytime.hxi.me/api/user/checkin?turnstile=secret'
      + '&pow_challenge=challenge&pow_nonce=nonce&month=2026-07'
  );
  const cloudflareUrl = sanitizeTraceUrl(
    'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/secret/path?token=secret'
  );
  const parsedApiUrl = new URL(apiUrl);

  assert.equal(parsedApiUrl.searchParams.get('turnstile'), '<redacted>');
  assert.equal(parsedApiUrl.searchParams.get('pow_challenge'), '<redacted>');
  assert.equal(parsedApiUrl.searchParams.get('pow_nonce'), '<redacted>');
  assert.equal(parsedApiUrl.searchParams.get('month'), '2026-07');
  assert.equal(cloudflareUrl, 'https://challenges.cloudflare.com/<redacted>');
});

test('requestTurnstileToken returns a token and removes its temporary widget', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<!doctype html><html><head></head><body></body></html>');
    await page.evaluate(() => {
      window.turnstile = {
        render(_element, options) {
          setTimeout(() => options.callback('widget-token-sentinel'), 0);
          return 'widget-sentinel';
        },
        remove(widgetId) {
          window.removedWidgetId = widgetId;
        },
      };
    });

    const result = await requestTurnstileToken(page, 'site-key-sentinel', 1000);
    const cleanup = await page.evaluate(() => ({
      mountExists: Boolean(document.getElementById('runanytime-turnstile-mount')),
      removedWidgetId: window.removedWidgetId,
    }));

    assert.deepEqual(result, { status: 'verified', token: 'widget-token-sentinel' });
    assert.deepEqual(cleanup, { mountExists: false, removedWidgetId: 'widget-sentinel' });
  } finally {
    await page.close();
  }
});

test('requestTurnstileToken preserves widget failure classification after cleanup', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<!doctype html><html><head></head><body></body></html>');
    await page.evaluate(() => {
      window.turnstile = {
        render(_element, options) {
          options['error-callback']();
          return 'failed-widget';
        },
        remove() {},
      };
    });

    const result = await requestTurnstileToken(page, 'site-key-sentinel', 20);
    const mountExists = await page.evaluate(
      () => Boolean(document.getElementById('runanytime-turnstile-mount'))
    );

    assert.deepEqual(result, { status: 'error' });
    assert.equal(mountExists, false);
    assert.match(formatTurnstileFailure(result, true), /HEADLESS=false/);
    assert.doesNotMatch(formatTurnstileFailure(result, false), /HEADLESS=false/);
  } finally {
    await page.close();
  }
});
