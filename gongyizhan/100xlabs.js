#!/usr/bin/env node
'use strict';

/**
 * cron: 15 8 * * *
 * new Env('100xLabs 每日签到');
 *
 * 必填环境变量:
 *   LABS100_ACCESS_TOKEN="Sub2API access token"
 */

const https = require('node:https');

const TASK_TITLE = '100xLabs 每日签到';
const LOG_PREFIX = '[100xLabs]';
const SITE_ORIGIN = 'https://sub.100xlabs.space';
const STATUS_PATH = '/api/v1/check-in/status?timezone=Asia%2FShanghai';
const CHECKIN_PATH = '/api/v1/check-in';
const TOKEN_ENV = 'LABS100_ACCESS_TOKEN';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

class Labs100Error extends Error {
  constructor(type, message) {
    super(message);
    this.name = 'Labs100Error';
    this.type = type;
  }
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getConfig(env = process.env) {
  const accessToken = cleanString(env[TOKEN_ENV]);
  if (!accessToken) {
    throw new Labs100Error(
      'config_error',
      `未配置环境变量 ${TOKEN_ENV}，请在青龙面板添加 Sub2API access token`
    );
  }

  return {
    accessToken,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

function sanitizeMessage(value) {
  return cleanString(value)
    .replace(/(authorization|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*\S+/gi, '$1=<redacted>')
    .slice(0, 300);
}

function extractMessage(data) {
  if (typeof data === 'string') return sanitizeMessage(data);
  if (!data || typeof data !== 'object') return '';

  for (const key of ['message', 'detail', 'error']) {
    if (typeof data[key] === 'string' && data[key].trim()) {
      return sanitizeMessage(data[key]);
    }
  }
  return '';
}

function unwrapPayload(data) {
  if (
    data
    && typeof data === 'object'
    && data.data !== undefined
    && (data.code === 0 || data.code === '0' || data.success === true)
  ) {
    return data.data;
  }
  return data;
}

function hasBusinessFailure(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.success === false) return true;
  if (data.code === undefined) return false;
  return ![0, '0', 'SUCCESS'].includes(data.code);
}

function isAuthFailure(status, message) {
  if (status === 401 || status === 403) return true;
  const text = cleanString(message).toLowerCase();
  return text.includes('unauthorized')
    || text.includes('authorization header')
    || text.includes('invalid token')
    || text.includes('token expired')
    || text.includes('expired token')
    || text.includes('not logged')
    || text.includes('未登录')
    || text.includes('登录过期')
    || text.includes('凭据失效');
}

function isChallengeMessage(message) {
  const text = cleanString(message).toLowerCase();
  return text.includes('turnstile')
    || text.includes('captcha')
    || text.includes('cloudflare')
    || text.includes('challenge')
    || text.includes('人机验证')
    || text.includes('安全验证');
}

function isHtmlChallenge(response) {
  const contentType = cleanString(response.contentType).toLowerCase();
  const text = cleanString(response.text).toLowerCase();
  return contentType.includes('text/html')
    || text.includes('<!doctype html')
    || text.includes('<html')
    || text.includes('cf-chl-')
    || text.includes('cloudflare');
}

function isAlreadyMessage(message) {
  const text = cleanString(message).toLowerCase();
  return text.includes('already checked')
    || text.includes('already signed')
    || text.includes('今日已签到')
    || text.includes('今天已签到')
    || text.includes('已经签到')
    || text.includes('重复签到');
}

function readReward(data) {
  if (!data || typeof data !== 'object') return undefined;
  for (const key of ['reward_amount', 'today_reward', 'reward']) {
    const value = data[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function failure(type, message) {
  return { type, message };
}

function analyzeStatusResponse(response) {
  const message = extractMessage(response.data);

  if (isHtmlChallenge(response) || isChallengeMessage(message)) {
    return failure('challenge_required', '站点触发 Cloudflare/Turnstile 验证，请前往网页人工签到');
  }
  if (isAuthFailure(response.status, message)) {
    return failure('auth_failed', `${TOKEN_ENV} 已失效，请在青龙面板手动更新`);
  }
  if (response.status < 200 || response.status >= 300) {
    return failure(
      'api_error',
      message ? `获取签到状态失败: ${message}` : `获取签到状态失败: HTTP ${response.status}`
    );
  }
  if (hasBusinessFailure(response.data)) {
    return failure(
      'api_error',
      message ? `获取签到状态失败: ${message}` : '获取签到状态失败: 远端接口拒绝请求'
    );
  }

  const data = unwrapPayload(response.data);
  if (!data || typeof data !== 'object' || typeof data.checked_in_today !== 'boolean') {
    return failure('schema_changed', '签到状态响应缺少 checked_in_today，站点接口可能已变化');
  }
  if (data.checked_in_today) {
    return { type: 'already_checked', message: '今日已签到', reward: readReward(data) };
  }
  if (data.turnstile_required === true) {
    return failure('challenge_required', '签到需要 Turnstile 验证，请前往网页人工签到');
  }
  return { type: 'ready', data };
}

function analyzeCheckinResponse(response) {
  const message = extractMessage(response.data);

  if (isHtmlChallenge(response) || isChallengeMessage(message)) {
    return failure('challenge_required', '签到需要 Turnstile 验证，请前往网页人工签到');
  }
  if (isAuthFailure(response.status, message)) {
    return failure('auth_failed', `${TOKEN_ENV} 已失效，请在青龙面板手动更新`);
  }
  if (isAlreadyMessage(message)) {
    return { type: 'already_checked', message: '今日已签到' };
  }
  if (response.status < 200 || response.status >= 300) {
    return failure(
      'api_error',
      message ? `签到请求失败: ${message}` : `签到请求失败: HTTP ${response.status}`
    );
  }

  const data = unwrapPayload(response.data);
  if (!data || typeof data !== 'object') {
    return failure('schema_changed', '签到响应格式异常，站点接口可能已变化');
  }
  if (data.already_checked_in === true) {
    return { type: 'already_checked', message: '今日已签到', reward: readReward(data) };
  }
  if (data.success === false || (data.code !== undefined && ![0, '0'].includes(data.code))) {
    return failure('api_error', message ? `签到失败: ${message}` : '签到失败: 远端接口拒绝请求');
  }
  return { type: 'submitted', reward: readReward(data), message };
}

function requestJson(config, apiPath, options = {}) {
  const method = options.method || 'GET';
  const url = new URL(apiPath, SITE_ORIGIN);
  const body = options.body === undefined ? null : JSON.stringify(options.body);
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${config.accessToken}`,
    Origin: SITE_ORIGIN,
    Referer: `${SITE_ORIGIN}/check-in`,
    'User-Agent': 'Mozilla/5.0 (Qinglong; 100xLabs daily check-in)',
  };

  if (body !== null) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    const request = https.request(url, { method, headers }, response => {
      const chunks = [];
      let totalBytes = 0;

      response.on('data', chunk => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          request.destroy(new Labs100Error('network_error', '远端响应过大，已停止读取'));
          return;
        }
        chunks.push(chunk);
      });

      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        if (text.trim()) {
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }
        }
        resolve({
          status: response.statusCode || 0,
          contentType: response.headers['content-type'] || '',
          data,
          text,
        });
      });
      response.on('error', error => {
        reject(new Labs100Error(
          'network_error',
          `读取远端响应失败: ${sanitizeMessage(error.message)}`
        ));
      });
    });

    request.setTimeout(config.timeoutMs, () => {
      request.destroy(new Labs100Error('network_error', `请求超时（${config.timeoutMs}ms）`));
    });
    request.on('error', error => {
      if (error instanceof Labs100Error) {
        reject(error);
        return;
      }
      reject(new Labs100Error('network_error', `网络请求失败: ${sanitizeMessage(error.message)}`));
    });

    if (body !== null) request.write(body);
    request.end();
  });
}

function formatReward(reward) {
  if (reward === undefined || reward === null || reward === '') return '';
  const number = Number(reward);
  if (Number.isFinite(number)) return `$${number.toFixed(2)}`;
  return sanitizeMessage(String(reward));
}

function formatResult(result) {
  if (result.type === 'success') {
    const reward = formatReward(result.reward);
    return reward ? `✅ 签到成功，获得 ${reward}` : '✅ 签到成功';
  }
  if (result.type === 'already_checked') {
    return '⏭️ 今日已签到';
  }
  return `❌ 发生异常：${result.message}`;
}

function getNotify() {
  try {
    const mod = require('./sendNotify');
    if (typeof mod === 'function') return mod;
    if (typeof mod?.sendNotify === 'function') return mod.sendNotify;
    if (typeof mod?.default === 'function') return mod.default;
  } catch {}
  return null;
}

async function sendResult(content) {
  const notify = getNotify();
  if (!notify) {
    console.log(`\n${TASK_TITLE}\n${content}`);
    return false;
  }

  try {
    return await Promise.resolve(notify(TASK_TITLE, content));
  } catch (error) {
    console.error(`${LOG_PREFIX} 通知发送失败: ${sanitizeMessage(error.message)}`);
    console.log(`\n${TASK_TITLE}\n${content}`);
    return false;
  }
}

async function run(config, request = requestJson) {
  console.log(`${LOG_PREFIX} 正在查询今日签到状态`);
  const initial = analyzeStatusResponse(await request(config, STATUS_PATH));
  if (initial.type !== 'ready') return initial;

  console.log(`${LOG_PREFIX} 今日未签到，正在提交签到请求`);
  const submitted = analyzeCheckinResponse(await request(config, CHECKIN_PATH, {
    method: 'POST',
    body: {},
  }));
  if (submitted.type !== 'submitted') return submitted;

  console.log(`${LOG_PREFIX} 正在复查签到状态`);
  const verified = analyzeStatusResponse(await request(config, STATUS_PATH));
  if (verified.type === 'already_checked') {
    return {
      type: 'success',
      message: '签到成功',
      reward: submitted.reward ?? verified.reward,
    };
  }
  if (verified.type === 'ready') {
    return failure('schema_changed', '签到请求已提交，但状态仍显示今日未签到');
  }
  return verified;
}

function printHelp() {
  console.log(`${TASK_TITLE}

用法:
  node gongyizhan/100xlabs.js

必填环境变量:
  ${TOKEN_ENV}    Sub2API 登录后的 access token

说明:
  脚本使用 ${SITE_ORIGIN} 官方 API 查询并执行签到。
  Token 过期后需要在青龙面板手动更新。
  如果站点要求 Turnstile，脚本不会绕过验证，而会提示前往网页人工签到。`);
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }
  if (argv.length > 0) {
    const result = failure('config_error', `未知参数: ${argv.join(' ')}，使用 --help 查看帮助`);
    await sendResult(formatResult(result));
    process.exitCode = 1;
    return;
  }

  let result;
  try {
    result = await run(getConfig());
  } catch (error) {
    result = failure(
      error instanceof Labs100Error ? error.type : 'runtime_error',
      error?.message ? sanitizeMessage(error.message) : '执行失败'
    );
  }

  const content = formatResult(result);
  console.log(`${LOG_PREFIX} ${content}`);
  await sendResult(content);
  if (!['success', 'already_checked'].includes(result.type)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(async error => {
    const content = formatResult(failure('runtime_error', `执行失败: ${sanitizeMessage(error.message)}`));
    console.error(`${LOG_PREFIX} ${content}`);
    await sendResult(content);
    process.exitCode = 1;
  });
}

module.exports = {
  Labs100Error,
  analyzeCheckinResponse,
  analyzeStatusResponse,
  cleanString,
  extractMessage,
  formatResult,
  formatReward,
  getConfig,
  hasBusinessFailure,
  isAuthFailure,
  isChallengeMessage,
  isHtmlChallenge,
  requestJson,
  run,
  sanitizeMessage,
  unwrapPayload,
};
