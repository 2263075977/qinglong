'use strict';
/**
 * cron: 25 8 * * *
 * new Env('RunAnytime 签到');
 *
 * 环境变量: RUNANYTIME_ACCOUNTS (Cookie)
 */

const crypto = require('crypto');

let axiosClient;

function getAxios() {
  axiosClient ||= require('axios');
  return axiosClient;
}

// 配置
const CONFIG = {
  BASE_URL: 'https://runanytime.hxi.me',
  ENV: 'RUNANYTIME_ACCOUNTS',
  USER_ID: '8514',
  TIMEOUT: 15000,
  POW_MAX: 100000000,
};

// 工具函数
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getNotify() {
  try {
    const notify = require('./sendNotify');
    return typeof notify === 'function' ? notify : notify?.sendNotify || notify?.default || null;
  } catch {
    return null;
  }
}

async function sendResult(notify, title, content) {
  if (typeof notify === 'function') {
    try {
      await notify(title, content);
      return;
    } catch {}
  }

  console.log(`\n${title}\n${content}`);
}

function buildHeaders(cookie) {
  return {
    Cookie: cookie,
    'new-api-user': CONFIG.USER_ID,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    Origin: CONFIG.BASE_URL,
    Referer: `${CONFIG.BASE_URL}/console/personal`,
    Accept: 'application/json, text/plain, */*',
  };
}

// PoW 计算
function solvePow(prefix, difficulty) {
  const fullZeros = Math.floor(difficulty / 4);
  const remainingBits = difficulty % 4;
  const targetPrefix = '0'.repeat(fullZeros);
  const mask = remainingBits > 0 ? (1 << (4 - remainingBits)) - 1 : 0;

  for (let nonce = 0; nonce < CONFIG.POW_MAX; nonce++) {
    const nonceHex = nonce.toString(16).padStart(8, '0');
    const hash = crypto.createHash('sha256').update(prefix + nonceHex).digest('hex');

    if (hash.startsWith(targetPrefix)) {
      if (remainingBits === 0 || (parseInt(hash[fullZeros], 16) & ~mask) === 0) {
        return nonceHex;
      }
    }
  }

  throw new Error('PoW 计算失败');
}

// 响应分析
function isTurnstileChallenge(message) {
  const text = String(message || '').toLowerCase();
  return text.includes('turnstile')
    || text.includes('cf-turnstile')
    || text.includes('人机验证');
}

function analyzeResponse(data, status) {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  const lowerText = text.toLowerCase();

  if (lowerText.includes('<!doctype html>') || lowerText.includes('bot detection')) {
    return {
      type: 'challenge_required',
      message: '站点触发浏览器安全验证，当前脚本未执行签到，请先在网页端手动签到',
    };
  }

  try {
    const json = typeof data === 'object' ? data : JSON.parse(data);

    if (json.success === true) {
      const quota = json.data?.quota_awarded?.toLocaleString();
      return { type: 'success', message: quota ? `签到成功，获得 ${quota} 配额` : '签到成功' };
    }

    const msg = json.message || '';
    if (msg.includes('已签到') || msg.includes('already')) {
      return { type: 'already_checked', message: '今日已签到' };
    }

    if (status === 401 || msg.includes('无权')) {
      return { type: 'auth_failed', message: `Cookie 已失效: ${msg}` };
    }

    if (isTurnstileChallenge(msg)) {
      return {
        type: 'challenge_required',
        message: '站点要求浏览器 Turnstile 验证，当前脚本未执行签到，请先在网页端手动签到',
      };
    }

    return { type: 'error', message: `签到失败: ${msg}` };
  } catch {
    return { type: 'error', message: '无法解析响应' };
  }
}

// API 调用
async function getChallenge(cookie) {
  const res = await getAxios().get(`${CONFIG.BASE_URL}/api/user/pow/challenge`, {
    params: { action: 'checkin' },
    headers: buildHeaders(cookie),
    timeout: CONFIG.TIMEOUT,
    validateStatus: () => true,
  });

  if (res.status === 401 || res.status === 403) {
    const err = new Error('Cookie 已失效');
    err.isAuthError = true;
    throw err;
  }

  if (res.status >= 500) {
    const err = new Error(`服务器错误: HTTP ${res.status}`);
    err.retriable = true;
    throw err;
  }

  const body = res.data;

  // 新格式
  if (body?.success && body.data) {
    const { challenge_id, prefix, difficulty } = body.data;
    if (challenge_id && prefix && typeof difficulty === 'number') {
      return { challengeId: challenge_id, prefix, difficulty };
    }
  }

  // 旧格式
  if (body?.challenge && typeof body.difficulty === 'number') {
    return {
      challengeId: body.challenge,
      prefix: body.challenge,
      difficulty: body.difficulty,
    };
  }

  throw new Error('Challenge 响应格式异常');
}

async function postCheckin(cookie, challengeId, nonce) {
  const url = `${CONFIG.BASE_URL}/api/user/checkin?pow_challenge=${encodeURIComponent(challengeId)}&pow_nonce=${encodeURIComponent(nonce)}`;

  const res = await getAxios().post(url, null, {
    headers: { ...buildHeaders(cookie), 'Content-Length': '0' },
    timeout: CONFIG.TIMEOUT,
    validateStatus: () => true,
  });

  if (res.status === 401 || res.status === 403) {
    return { type: 'auth_failed', message: 'Cookie 已失效' };
  }

  if (res.status >= 500) {
    const err = new Error(`HTTP ${res.status}`);
    err.retriable = true;
    throw err;
  }

  if (res.status >= 200 && res.status < 300) {
    return analyzeResponse(res.data, res.status);
  }

  return { type: 'error', message: `请求失败 (HTTP ${res.status})` };
}

// 签到流程
async function checkin(cookie) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { challengeId, prefix, difficulty } = await getChallenge(cookie);
      const nonce = solvePow(prefix, difficulty);
      const result = await postCheckin(cookie, challengeId, nonce);
      return { ...result, attempts: attempt };
    } catch (err) {
      if (err.isAuthError) {
        return { type: 'auth_failed', message: err.message, attempts: attempt };
      }

      const shouldRetry = err.retriable && attempt < 3;
      if (!shouldRetry) {
        return { type: 'error', message: err.message, attempts: attempt };
      }

      const delay = 2000 * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }

  return { type: 'error', message: '重试结束但未获得结果', attempts: 3 };
}

// 主流程
async function main() {
  const notify = getNotify();
  const cookie = process.env[CONFIG.ENV];

  if (!cookie?.trim()) {
    await sendResult(notify, 'RunAnytime 自动签到', `❌ 发生异常：未配置 ${CONFIG.ENV}`);
    return;
  }

  const result = await checkin(cookie.trim());

  let notifyContent = '';
  if (result.type === 'success') {
    notifyContent = `✅ ${result.message} (尝试 ${result.attempts} 次)`;
  } else if (result.type === 'already_checked') {
    notifyContent = '⏭️ 今日已签到';
  } else if (result.type === 'challenge_required') {
    notifyContent = `❌ 发生异常：验证阻断：${result.message}`;
  } else {
    notifyContent = `❌ 发生异常：${result.message}`;
  }

  await sendResult(notify, 'RunAnytime 自动签到', notifyContent);
}

if (require.main === module) {
  main().catch(async (err) => {
    try {
      await sendResult(getNotify(), 'RunAnytime 自动签到', `❌ 发生异常：执行异常: ${err.message}`);
    } catch {}
    process.exitCode = 1;
  });
}

module.exports = {
  analyzeResponse,
  isTurnstileChallenge,
};
