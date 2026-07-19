#!/usr/bin/env node
'use strict';

/**
 * cron: 15 8 * * *
 * new Env('100xLabs 每日签到');
 *
 * 首次运行必填环境变量:
 *   LABS100_REFRESH_TOKEN="Sub2API refresh token"
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const TASK_TITLE = '100xLabs 每日签到';
const LOG_PREFIX = '[100xLabs]';
const SITE_ORIGIN = 'https://sub.100xlabs.space';
const REFRESH_PATH = '/api/v1/auth/refresh';
const STATUS_PATH = '/api/v1/check-in/status?timezone=Asia%2FShanghai';
const CHECKIN_PATH = '/api/v1/check-in';
const REFRESH_TOKEN_ENV = 'LABS100_REFRESH_TOKEN';
const AUTH_STATE_FILENAME = '100xlabs-auth-state.json';
const AUTH_STATE_VERSION = 1;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
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

function getAuthStateFile(env = process.env, homeDirectory = os.homedir()) {
  const qlDataDirectory = cleanString(env.QL_DATA_DIR);
  if (qlDataDirectory) {
    return path.join(qlDataDirectory, 'config', AUTH_STATE_FILENAME);
  }

  const qlDirectory = cleanString(env.QL_DIR);
  if (qlDirectory) {
    return path.join(qlDirectory, 'config', AUTH_STATE_FILENAME);
  }

  return path.join(homeDirectory, '.100xlabs', AUTH_STATE_FILENAME);
}

function getConfig(env = process.env) {
  return {
    refreshTokenSeed: cleanString(env[REFRESH_TOKEN_ENV]),
    stateFile: getAuthStateFile(env),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

function sanitizeMessage(value) {
  return cleanString(value)
    .replace(/(\bBearer\s+)[^\s"',;}]+/gi, '$1<redacted>')
    .replace(
      /(["']?(?:authorization|access[_ -]?token|refresh[_ -]?token)["']?\s*[:=]\s*["'])[^"']*(["'])/gi,
      '$1<redacted>$2'
    )
    .replace(
      /((?:authorization|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*)[^\s,;}]+/gi,
      '$1<redacted>'
    )
    .slice(0, 300);
}

function fingerprintRefreshToken(refreshToken) {
  return `sha256:${crypto.createHash('sha256').update(refreshToken, 'utf8').digest('hex')}`;
}

function validateAuthState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Labs100Error('state_error', '认证状态格式损坏，请重新获取 refresh token 进行恢复');
  }
  if (value.version !== AUTH_STATE_VERSION) {
    throw new Labs100Error('state_error', '认证状态版本不受支持，请更新脚本或重新初始化状态');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(cleanString(value.seed_fingerprint))) {
    throw new Labs100Error('state_error', '认证状态指纹无效，请重新获取 refresh token 进行恢复');
  }

  const refreshToken = cleanString(value.refresh_token);
  const updatedAt = cleanString(value.updated_at);
  if (!refreshToken || !updatedAt || !Number.isFinite(Date.parse(updatedAt))) {
    throw new Labs100Error('state_error', '认证状态字段缺失，请重新获取 refresh token 进行恢复');
  }

  return {
    version: AUTH_STATE_VERSION,
    seed_fingerprint: value.seed_fingerprint,
    refresh_token: refreshToken,
    updated_at: updatedAt,
  };
}

async function ensurePrivateDirectory(stateFile, fileSystem = fs.promises) {
  const directory = path.dirname(stateFile);
  try {
    await fileSystem.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await fileSystem.chmod(directory, PRIVATE_DIRECTORY_MODE);
  } catch {
    throw new Labs100Error('state_error', '无法创建私有认证状态目录，请检查青龙持久目录权限');
  }
}

async function readAuthState(stateFile, fileSystem = fs.promises) {
  try {
    const stateStat = await fileSystem.lstat(stateFile);
    if (!stateStat.isFile()) {
      throw new Labs100Error('state_error', '认证状态不是普通文件，请检查持久目录并重新恢复凭据');
    }
    await fileSystem.chmod(stateFile, PRIVATE_FILE_MODE);
    const content = await fileSystem.readFile(stateFile, 'utf8');
    return validateAuthState(JSON.parse(content));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof Labs100Error) throw error;
    if (error instanceof SyntaxError) {
      throw new Labs100Error('state_error', '认证状态无法解析，请重新获取 refresh token 进行恢复');
    }
    throw new Labs100Error('state_error', '读取认证状态失败，请检查青龙持久目录权限');
  }
}

async function writeAuthStateAtomic(stateFile, state, fileSystem = fs.promises) {
  const normalizedState = validateAuthState(state);
  await ensurePrivateDirectory(stateFile, fileSystem);

  const directory = path.dirname(stateFile);
  const temporaryFile = path.join(
    directory,
    `.${path.basename(stateFile)}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  let handle = null;
  let renamed = false;

  try {
    handle = await fileSystem.open(temporaryFile, 'wx', PRIVATE_FILE_MODE);
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(`${JSON.stringify(normalizedState, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fileSystem.rename(temporaryFile, stateFile);
    renamed = true;
    await fileSystem.chmod(stateFile, PRIVATE_FILE_MODE);
  } catch (error) {
    if (error instanceof Labs100Error) throw error;
    throw new Labs100Error(
      'state_error',
      '保存轮换后的认证状态失败，请重新获取 refresh token 进行恢复'
    );
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {}
    }
    if (!renamed) {
      try {
        await fileSystem.unlink(temporaryFile);
      } catch {}
    }
  }
}

function selectRefreshCredential(refreshTokenSeed, state) {
  const seed = cleanString(refreshTokenSeed);
  if (!state) {
    if (!seed) {
      throw new Labs100Error(
        'config_error',
        `未找到认证状态，请在青龙面板配置 ${REFRESH_TOKEN_ENV}`
      );
    }
    return {
      refreshToken: seed,
      seedFingerprint: fingerprintRefreshToken(seed),
      source: 'environment',
    };
  }

  const normalizedState = validateAuthState(state);
  if (!seed || fingerprintRefreshToken(seed) === normalizedState.seed_fingerprint) {
    return {
      refreshToken: normalizedState.refresh_token,
      seedFingerprint: normalizedState.seed_fingerprint,
      source: 'state',
    };
  }

  return {
    refreshToken: seed,
    seedFingerprint: fingerprintRefreshToken(seed),
    source: 'environment',
  };
}

async function createAuthLock(lockPath, owner, fileSystem = fs.promises) {
  let handle = null;
  let created = false;
  try {
    handle = await fileSystem.open(lockPath, 'wx', PRIVATE_FILE_MODE);
    created = true;
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(`${owner}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    return { path: lockPath, owner };
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {}
    }
    if (created) {
      try {
        await fileSystem.unlink(lockPath);
      } catch {}
    }
    throw error;
  }
}

async function acquireAuthLock(stateFile, timeoutMs, fileSystem = fs.promises) {
  await ensurePrivateDirectory(stateFile, fileSystem);
  const lockPath = `${stateFile}.lock`;
  const owner = `${process.pid}:${Date.now()}:${crypto.randomBytes(12).toString('hex')}`;

  try {
    return await createAuthLock(lockPath, owner, fileSystem);
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw new Labs100Error('state_error', '创建认证轮换锁失败，请检查青龙持久目录权限');
    }
  }

  let observedOwner;
  let lockStat;
  try {
    [observedOwner, lockStat] = await Promise.all([
      fileSystem.readFile(lockPath, 'utf8'),
      fileSystem.lstat(lockPath),
    ]);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new Labs100Error('state_error', '检查认证轮换锁失败，请检查青龙持久目录权限');
    }
  }

  if (lockStat && !lockStat.isFile()) {
    throw new Labs100Error('state_error', '认证轮换锁不是普通文件，请检查青龙持久目录');
  }

  const normalizedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const staleAfterMs = normalizedTimeoutMs * 2;
  if (lockStat && Date.now() - lockStat.mtimeMs <= staleAfterMs) {
    throw new Labs100Error('auth_busy', '另一个签到任务正在刷新凭据，请稍后重试');
  }

  if (lockStat) {
    try {
      const currentOwner = await fileSystem.readFile(lockPath, 'utf8');
      if (currentOwner !== observedOwner) {
        throw new Labs100Error('auth_busy', '另一个签到任务正在刷新凭据，请稍后重试');
      }
      await fileSystem.unlink(lockPath);
    } catch (error) {
      if (error instanceof Labs100Error) throw error;
      if (error?.code !== 'ENOENT') {
        throw new Labs100Error('state_error', '恢复陈旧认证锁失败，请检查青龙持久目录权限');
      }
    }
  }

  try {
    return await createAuthLock(lockPath, owner, fileSystem);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Labs100Error('auth_busy', '另一个签到任务正在刷新凭据，请稍后重试');
    }
    throw new Labs100Error('state_error', '创建认证轮换锁失败，请检查青龙持久目录权限');
  }
}

async function releaseAuthLock(lock, fileSystem = fs.promises) {
  try {
    const currentOwner = await fileSystem.readFile(lock.path, 'utf8');
    if (currentOwner !== `${lock.owner}\n`) {
      throw new Labs100Error('state_error', '认证轮换锁所有权发生变化，请稍后重试');
    }
    await fileSystem.unlink(lock.path);
  } catch (error) {
    if (error instanceof Labs100Error) throw error;
    throw new Labs100Error('state_error', '释放认证轮换锁失败，请检查青龙持久目录权限');
  }
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

function isRefreshAuthFailure(status, message) {
  if (isAuthFailure(status, message)) return true;
  const text = cleanString(message).toLowerCase().replace(/[_-]+/g, ' ');
  const mentionsCredential = text.includes('token')
    || text.includes('令牌')
    || text.includes('凭据');
  return mentionsCredential
    && (
      text.includes('invalid')
      || text.includes('expired')
      || text.includes('revoked')
      || text.includes('reused')
      || text.includes('used')
      || text.includes('not found')
      || text.includes('无效')
      || text.includes('过期')
      || text.includes('撤销')
      || text.includes('失效')
      || text.includes('已使用')
      || text.includes('重复')
    );
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
    return failure(
      'auth_failed',
      `本轮登录凭据已失效，请重新获取并替换 ${REFRESH_TOKEN_ENV}`
    );
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
    return failure(
      'auth_failed',
      `本轮登录凭据已失效，请重新获取并替换 ${REFRESH_TOKEN_ENV}`
    );
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

function analyzeRefreshResponse(response) {
  const message = extractMessage(response.data);

  if (isHtmlChallenge(response) || isChallengeMessage(message)) {
    return failure(
      'challenge_required',
      `刷新登录凭据时触发安全验证，请重新登录并替换 ${REFRESH_TOKEN_ENV}`
    );
  }
  if (isRefreshAuthFailure(response.status, message)) {
    return failure(
      'auth_failed',
      `refresh token 已失效、过期或被撤销，请重新登录并替换 ${REFRESH_TOKEN_ENV}`
    );
  }
  if (response.status === 429) {
    return failure('api_error', '刷新登录凭据请求过于频繁，请稍后重试');
  }
  if (response.status < 200 || response.status >= 300) {
    return failure(
      'api_error',
      message
        ? `刷新登录凭据失败: ${message}；请稍后重试`
        : `刷新登录凭据失败: HTTP ${response.status}；请稍后重试`
    );
  }
  if (hasBusinessFailure(response.data)) {
    return failure(
      'api_error',
      message
        ? `刷新登录凭据失败: ${message}；请稍后重试`
        : '刷新登录凭据失败: 远端接口拒绝请求，请稍后重试'
    );
  }

  const data = unwrapPayload(response.data);
  const accessToken = cleanString(data?.access_token);
  const refreshToken = cleanString(data?.refresh_token);
  const expiresIn = Number(data?.expires_in);
  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return failure(
      'schema_changed',
      '刷新响应缺少 access_token、refresh_token 或有效 expires_in，请更新脚本后重试'
    );
  }

  return {
    type: 'refreshed',
    accessToken,
    refreshToken,
    expiresIn,
  };
}

function requestJson(config, apiPath, options = {}) {
  const method = options.method || 'GET';
  const url = new URL(apiPath, SITE_ORIGIN);
  const body = options.body === undefined ? null : JSON.stringify(options.body);
  const headers = {
    Accept: 'application/json',
    Origin: SITE_ORIGIN,
    Referer: `${SITE_ORIGIN}/check-in`,
    'User-Agent': 'Mozilla/5.0 (Qinglong; 100xLabs daily check-in)',
  };

  const accessToken = cleanString(options.accessToken);
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

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

async function refreshSession(config, dependencies = {}) {
  const request = dependencies.request || requestJson;
  const readState = dependencies.readState || readAuthState;
  const writeState = dependencies.writeState || writeAuthStateAtomic;
  const acquireLock = dependencies.acquireLock || acquireAuthLock;
  const releaseLock = dependencies.releaseLock || releaseAuthLock;
  const now = dependencies.now || (() => new Date());
  const stateFile = cleanString(config.stateFile);

  if (!stateFile) {
    throw new Labs100Error('config_error', '未能确定认证状态文件位置，请检查青龙目录配置');
  }

  const lock = await acquireLock(stateFile, config.timeoutMs);
  try {
    const state = await readState(stateFile);
    const credential = selectRefreshCredential(config.refreshTokenSeed, state);
    let response;
    try {
      response = await request({ timeoutMs: config.timeoutMs }, REFRESH_PATH, {
        method: 'POST',
        body: { refresh_token: credential.refreshToken },
      });
    } catch (error) {
      if (error instanceof Labs100Error && error.type !== 'network_error') throw error;
      const diagnostic = error instanceof Labs100Error
        ? sanitizeMessage(error.message)
        : '网络请求失败';
      throw new Labs100Error('network_error', `${diagnostic}；请检查网络后重试`);
    }
    const refreshed = analyzeRefreshResponse(response);
    if (refreshed.type !== 'refreshed') return refreshed;

    const updatedAt = new Date(now()).toISOString();
    await writeState(stateFile, {
      version: AUTH_STATE_VERSION,
      seed_fingerprint: credential.seedFingerprint,
      refresh_token: refreshed.refreshToken,
      updated_at: updatedAt,
    });

    return refreshed;
  } finally {
    await releaseLock(lock);
  }
}

async function runCheckin(config, request = requestJson) {
  console.log(`${LOG_PREFIX} 正在查询今日签到状态`);
  const initial = analyzeStatusResponse(await request(config, STATUS_PATH, {
    accessToken: config.accessToken,
  }));
  if (initial.type !== 'ready') return initial;

  console.log(`${LOG_PREFIX} 今日未签到，正在提交签到请求`);
  const submitted = analyzeCheckinResponse(await request(config, CHECKIN_PATH, {
    method: 'POST',
    body: {},
    accessToken: config.accessToken,
  }));
  if (submitted.type !== 'submitted') return submitted;

  console.log(`${LOG_PREFIX} 正在复查签到状态`);
  const verified = analyzeStatusResponse(await request(config, STATUS_PATH, {
    accessToken: config.accessToken,
  }));
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

async function run(config, dependencies = {}) {
  const normalizedDependencies = typeof dependencies === 'function'
    ? { request: dependencies }
    : dependencies;
  const request = normalizedDependencies.request || requestJson;

  console.log(`${LOG_PREFIX} 正在刷新登录凭据`);
  const session = await refreshSession(config, { ...normalizedDependencies, request });
  if (session.type !== 'refreshed') return session;

  return runCheckin({ timeoutMs: config.timeoutMs, accessToken: session.accessToken }, request);
}

function printHelp() {
  console.log(`${TASK_TITLE}

用法:
  node gongyizhan/100xlabs.js

首次运行必填环境变量:
  ${REFRESH_TOKEN_ENV}    Sub2API 登录后的 refresh token

说明:
  脚本先通过 ${SITE_ORIGIN} 官方 refresh 接口轮换登录凭据，再查询并执行签到。
  推荐在无痕窗口登录后，从 localStorage 复制 refresh_token；复制后直接关闭全部
  无痕窗口，不要点击“退出登录”，否则刚复制的 token 会被撤销。
  首次刷新成功后，轮换状态会保存在青龙持久目录的私有文件中；环境变量仅作为
  首次种子，可以保留或删除。保留时脚本不会重复使用已经轮换过的旧 seed。
  凭据失效后，请重新登录并用新的 refresh token 替换 ${REFRESH_TOKEN_ENV}，脚本
  会自动识别新 seed，无需手动编辑状态文件。
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
  analyzeRefreshResponse,
  analyzeStatusResponse,
  acquireAuthLock,
  cleanString,
  extractMessage,
  fingerprintRefreshToken,
  formatResult,
  formatReward,
  getAuthStateFile,
  getConfig,
  hasBusinessFailure,
  isAuthFailure,
  isChallengeMessage,
  isHtmlChallenge,
  readAuthState,
  refreshSession,
  releaseAuthLock,
  requestJson,
  run,
  runCheckin,
  sanitizeMessage,
  selectRefreshCredential,
  unwrapPayload,
  validateAuthState,
  writeAuthStateAtomic,
};
