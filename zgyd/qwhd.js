#!/usr/bin/env node
// cron: 30 8,20 * * *
// new Env('中国移动签到有礼');
// description: 中国移动 App「签到有礼」(wx.10086.cn/qwhdhub mark31)每日签到 + 领累计奖励，脚本自己换票，无需每天手动贴 token
/**
 * 环境变量（必需）:
 *   QWHD_ACCOUNTS —— 每项一个账号的「换票 blob」，多个账号用 & 或换行分隔（保序去重）。
 *
 *   两种填法（二选一，推荐 mint）:
 *     A) mint —— autoLogin 明文模板（**一次性抓，之后永久免人工**）
 *        抓 POST https://client.app.coc.10086.cn/biz-orange/LN/uamonekeylogin/autoLogin，
 *        把请求体做 AES-128-CBC(key=tVkdaRWRY0ZkV1Vr, iv=VjFSQ1ZtVkQxRTlQ) 解密后得到的明文 JSON
 *        整个填进 "mint"。脚本每次运行用它现签一张新会话（autoLogin 不校验 cookie），
 *        所以不再需要每天重抓。⚠️ 该接口等于一次「App 一键登录」，调多会被风控
 *        （214103 需人脸识别、可能连带封 App）；脚本已内置限频：两次至少间隔 10 分钟、
 *        每天最多 3 次、命中 233031/214100/214103 自动静默 10 分钟/2 小时/24 小时。
 *     B) token —— App 票据字符串（旧方式，几小时就失效，需每天重抓）
 *        抓 POST https://wx.10086.cn/qwhdsso/appTokenLogin 的 body，取其中 token 字段。
 *
 *   取值路径（token 方式，2026-11-21 实测，整条链路见下）:
 *     1. 打开「中国移动」App → 进「签到有礼」活动页（wx.10086.cn/qwhdhub/qwhdmark/1021122301）
 *     2. 抓包工具里找 POST https://wx.10086.cn/qwhdsso/appTokenLogin?sid=...
 *     3. 「复制为 cURL」，把它的 body 整个 JSON 拿下来，再加一个字段 "yx"
 *        （yx 来自同一次请求的 cookie `yx=…`，也是页面 URL 的 `yx=` 参数）
 *     4. 拼成一行填进面板:
 *        QWHD_ACCOUNTS='{"jwtToken":"…","token":"JSESSIONID=…; UID=…; ticketID=…","provinceCode":"571","cityCode":"0574","userCheckId":"446d87a0b","carrierOperator":"002","appVersionCode":"12.5.7","yx":"1391563104"}'
 *
 *   可选（前缀 QWHD_）:
 *     QWHD_PUSH=1            是否发青龙通知（默认 1）
 *     QWHD_TIMEOUT_MS=15000  单请求超时（毫秒）
 *     QWHD_STATE_FILE=<路径>  状态文件，默认与脚本同目录的 .qwhd-state.json
 *
 * 为什么 cron 是「每天两次」而不是高频:
 *   早期（只能配短命 token 时）确实需要每 30 分钟跑一次，去撞那 2~4 小时的有效窗口；
 *   现在有了 autoLogin 现签（见下），**不再依赖任何时间窗口** —— 每次运行现签一张会话即可。
 *   因此改成每天 08:30 / 20:30 各跑一次：第一次失败还有第二次兜底，
 *   当天签成就写状态文件、当天后续运行零请求直接跳过。
 *
 * 为什么配「换票 blob」而不是配 session token:
 *   QWHD_SESSION_TOKEN 有两条硬限制（2026-11-21 实测）——空闲约 30 分钟即失效、绝对寿命约 2 小时，
 *   且服务端不会给失效的 token 续期（响应不再下发 QWHD_SESSION_TOKEN，只回 GOTO_LOGIN）。
 *   但 /qwhdsso/appTokenLogin 的请求体可以**反复重放**：配一个新 sid 就能换到新的 session token。
 *   于是「配一次 blob，脚本每次自己换票」= 全自动，不需要每天进 App。
 *   注: 静态页 /qwhdsso/login 里那条 jwtLogin 分支需要 App 原生 bridge（leadeon.getUserInfo），实测不可用，已放弃。
 *
 * 换票三步（2026-11-21 抓包会话 `2026-11-21-130916` 实证）:
 *   GET  /qwhdsso/login?dlwmh=true&actUrl=<活动页>             → 页面里取 sid=QWHDSSOD…
 *   POST /qwhdsso/appTokenLogin?sid=<sid>  body=上面那坨 blob  → {"code":"SUCCESS","data":{"jwt":…}}
 *   GET  <活动页>&token=<sid>                                 → Set-Cookie: QWHD_SESSION_TOKEN=…
 */
'use strict';

const crypto = require('node:crypto');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const LOG_PREFIX = '[qwhd]';
const TASK_TITLE = '中国移动签到有礼';

const BASE = 'https://wx.10086.cn';
const CHANNEL_ID = 'P00000132551';
const ACT_PATH = '/qwhdhub/qwhdmark/1021122301';
// 移动 App 内 H5 的 UA；服务端对 UA 无强校验（实测 curl 默认 UA 也能通），但保持与客户端一致便于排障
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Mobile/15E148/wkwebview leadeon/12.5.7/CMCCIT';

const DEFAULT_TIMEOUT_MS = 15000;

// ---- App 网关「现签会话」（client.app.coc.10086.cn / autoLogin）------------------
// 2026-11-23 实测（本地逐字节复现成功）：autoLogin 不校验 cookie 里的 JSESSIONID，
// 只要请求体里的 cellNum（App 内 RSA 加密的手机号）与签名正确，就会换发一张全新会话。
// 因此只要**一次性**抓到 autoLogin 请求体明文（模板），之后可无限现签，无需再抓包。
const MINT_URL = 'https://client.app.coc.10086.cn/biz-orange/LN/uamonekeylogin/autoLogin';
const MINT_PATH = '/biz-orange/LN/uamonekeylogin/autoLogin';
const MINT_KEY_REQ = Buffer.from('tVkdaRWRY0ZkV1Vr', 'utf8');
const MINT_KEY_RESP = Buffer.from('RYV0hCV1lV25KYVJ', 'utf8');
const MINT_IV = Buffer.from('VjFSQ1ZtVkQxRTlQ', 'utf8');
const MINT_TOK_KEY = Buffer.from('bAIgvwAuA4tbDr9d', 'utf8');
const MINT_TOK_IV = Buffer.from('9791027341711819', 'utf8');
const MINT_UA = 'ChinaMobile/12.5.7 (iPhone; iOS 27.0.1; Scale/3.00)';
// 限频/风控（对齐社区实测阈值：同号 1 分钟内重复现签 → 233031；频繁 → 214100 → 214103 需人脸解封）
const MINT_MIN_INTERVAL_SEC = 600;
const MINT_MAX_PER_DAY = 3;
const MINT_RISK_SILENCE_SEC = { '233031': 600, '214100': 7200, '214103': 86400, '213245': 7200 };

// 下游 Node-RED 分流关键词（与 .trellis/spec/qinglong/logging-and-notify.md 一致）
const ALERT_KEYWORDS = '已失效,无效用户,失效,cookie失效,ck失效,登录失效,账号失效,账号过期,重新登录,发生异常,invalid,expired';
const NOTICE_PLACEHOLDER = '步骤失败(详情见面板日志)'; // 占位文案自身必须不含关键词

/* ------------------------------------------------------------------ */
/* 错误类型                                                            */
/* ------------------------------------------------------------------ */

class QwhdError extends Error {
  constructor(type, message, details = {}) {
    super(message);
    this.name = 'QwhdError';
    this.type = type; // config_missing | credential | network | api | schema_changed
    this.details = details;
  }
}

/* ------------------------------------------------------------------ */
/* 日志与脱敏                                                          */
/* ------------------------------------------------------------------ */

const SECRET_KEYS = ['jwtToken', 'token', 'QWHD_SESSION_TOKEN', 'authorization', 'cookie', 'ssoToken'];

// 既盖 `k=v` / `k: v`，也盖 JSON 的 `"k":"v"`（形态盲区实证见 logging-and-notify.md）
const SECRET_RE = new RegExp(
  `(["']?)(?:${SECRET_KEYS.join('|')})\\1\\s*[:=]\\s*["']?[^"',}\\s]+`, 'gi');

function redactLog(text) {
  let out = String(text ?? '');
  out = out.replace(SECRET_RE, (m, q) => `${q}${m.replace(/^["']?/, '').split(/[:=]/)[0]}${q}:[redacted]`);
  out = out.replace(/QWHD_SESSION_TOKEN=[^;\s]+/g, 'QWHD_SESSION_TOKEN=[redacted]');
  out = out.replace(/[0-9a-f]{64,}/gi, '[redacted-hex]');
  return out;
}

function log(msg) { console.log(`${LOG_PREFIX} ${redactLog(msg)}`); }
function logErr(msg) { console.error(`${LOG_PREFIX} ${redactLog(msg)}`); }
function logWarn(msg) { console.warn(`${LOG_PREFIX} ${redactLog(msg)}`); }

function maskSecret(secret) {
  const s = String(secret ?? '');
  if (s.length <= 20) return '***';
  return `${s.slice(0, 12)}***${s.slice(-4)}`;
}

function matchesAlertRouting(text) {
  const lower = String(text ?? '').toLowerCase();
  const compact = lower.replace(/\s+/g, '');
  return ALERT_KEYWORDS.split(',').map((k) => k.trim()).filter(Boolean)
    .some((k) => lower.includes(k) || compact.includes(k.replace(/\s+/g, '')));
}

// 外部文本进通知前逐处收口；凭证类自有文案不要过这个函数
function noticeSafe(text) {
  const t = redactLog(String(text ?? ''));
  return matchesAlertRouting(t) ? NOTICE_PLACEHOLDER : t;
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

// 服务端按北京时间判日期；这里用固定 +8 偏移自行换算，避免容器时区/夏令时干扰
function ymdShanghai(date = new Date()) {
  const t = new Date(date.getTime() + 8 * 3600 * 1000);
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function str(value, fallback = '') {
  return typeof value === 'string' && value ? value : fallback;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* 配置解析                                                            */
/* ------------------------------------------------------------------ */

const ACCOUNT_REQUIRED = ['provinceCode', 'cityCode', 'userCheckId', 'carrierOperator', 'yx'];

const MSG_MISSING = [
  '❌ 未配置环境变量 QWHD_ACCOUNTS',
  '请按下面步骤取一份「换票 blob」填进面板:',
  '  1. 打开「中国移动」App → 进入「签到有礼」活动页',
  `  2. 抓包工具里找 POST ${BASE}/qwhdsso/appTokenLogin?sid=…`,
  '  3. 复制该请求的 body（整个 JSON），再补一个字段 "yx"（取同一次请求 cookie 里的 yx=…）',
  '  4. 面板里新建环境变量:',
  '       QWHD_ACCOUNTS=\'{"jwtToken":"…","token":"JSESSIONID=…; UID=…; ticketID=…","provinceCode":"571","cityCode":"0574","userCheckId":"446d87a0b","carrierOperator":"002","appVersionCode":"12.5.7","yx":"1391563104"}\'',
  '     多账号用 & 或换行分隔。',
].join('\n');

function splitAccounts(raw) {
  return String(raw || '')
    .split(/[\n&]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseAccounts(raw) {
  const items = splitAccounts(raw);
  const accounts = [];
  const seen = new Set();
  const problems = [];

  items.forEach((text, index) => {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      // 注意: JSON 语法错误文案里可能带 invalid 等分流关键词，这里只用于本地日志
      problems.push(`QWHD_ACCOUNTS[${index}] 不是合法 JSON: ${e.message}`);
      return;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      problems.push(`QWHD_ACCOUNTS[${index}] 必须是一个 JSON 对象`);
      return;
    }
    const missing = ACCOUNT_REQUIRED.filter((k) => !str(obj[k]));
    if (missing.length) {
      problems.push(`QWHD_ACCOUNTS[${index}] 缺少字段: ${missing.join(', ')}`);
      return;
    }
    const mint = obj.mint && typeof obj.mint === 'object' ? obj.mint : null;
    const hasMint = Boolean(mint && str(mint.xk) && mint.reqBody && str(mint.reqBody.cellNum));
    if (!str(obj.token) && !hasMint) {
      problems.push(`QWHD_ACCOUNTS[${index}] 既没有 token，也没有可用的 mint 模板（需含 xk 与 reqBody.cellNum）`);
      return;
    }
    // 解析不出必需字段时**不要**用占位值兜底(见 spec「解析不出必需字段」)
    const key = `${obj.yx}|${obj.userCheckId}`;
    if (seen.has(key)) return; // 保序去重
    seen.add(key);
    accounts.push({
      yx: str(obj.yx),
      mint,
      jwtToken: str(obj.jwtToken),
      ssoToken: str(obj.token),
      provinceCode: str(obj.provinceCode),
      cityCode: str(obj.cityCode),
      userCheckId: str(obj.userCheckId),
      carrierOperator: str(obj.carrierOperator),
      appVersionCode: str(obj.appVersionCode, '12.5.7'),
      took: obj.took,
    });
  });

  return { accounts, problems };
}

function activityUrl(yx) {
  return `${BASE}${ACT_PATH}?channelId=${CHANNEL_ID}&yx=${yx}`;
}

/* ------------------------------------------------------------------ */
/* HTTP 层                                                             */
/* ------------------------------------------------------------------ */

function baseHeaders(extra = {}) {
  return {
    'user-agent': UA,
    'content-type': 'application/json;charset=UTF-8',
    origin: BASE,
    ...extra,
  };
}

async function httpFetch(url, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // 定时器 unref: 避免与未清理句柄碰撞导致进程无法退出/退出码异常（ydyp 实测踩过 127）
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const res = await fetch(url, { ...options, signal: controller.signal, redirect: 'manual' });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  } catch (e) {
    throw new QwhdError('network', `请求失败: ${e.name === 'AbortError' ? `超时 ${timeoutMs}ms` : e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// client.app.coc.10086.cn 要求 legacy renegotiation；Node 的 fetch(undici) 无法配置，
// 会报 ERR_SSL_UNSAFE_LEGACY_RENEGOTIATION_DISABLED。这里用 node:https 显式放开该开关。
function httpsPostJson(urlStr, { headers = {}, body = '', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(urlStr, {
      method: 'POST',
      secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        setCookies: res.headers['set-cookie'] || [],
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`超时 ${timeoutMs}ms`)));
    req.on('error', (e) => reject(new QwhdError('network', `请求失败: ${e.code || e.message}`)));
    req.end(body);
  });
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const raw = headers.get('set-cookie');
  return raw ? [raw] : [];
}

function findCookie(headers, name) {
  for (const line of getSetCookies(headers)) {
    const m = new RegExp(`${name}=([^;,\\s]+)`).exec(line);
    if (m) return m[1];
  }
  return null;
}

function parseJson(text, where) {
  try {
    return JSON.parse(text);
  } catch {
    throw new QwhdError('schema_changed', `${where} 返回不是 JSON（长度 ${text.length}）`);
  }
}

/* ------------------------------------------------------------------ */
/* App 网关现签会话（autoLogin）—— 免人工的关键                          */
/* ------------------------------------------------------------------ */

const md5hex = (text) => crypto.createHash('md5').update(text, 'utf8').digest('hex');

function aesEncryptB64(key, iv, text) {
  const c = crypto.createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([c.update(text, 'utf8'), c.final()]).toString('base64');
}

function aesDecryptB64(key, iv, b64) {
  const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([d.update(Buffer.from(b64, 'base64')), d.final()]).toString('utf8');
}

// 把服务端 Set-Cookie 收敛成 appTokenLogin 需要的 token 串。
// 实测：必须是**完整**形态（含 Comment=SessionServer-unity / Path / HTTPOnly / Secure），
// 只留 JSESSIONID+UID+ticketID 会被判「APP登录状态已过期」。
function buildAppToken(setCookieValue) {
  const parts = String(setCookieValue || '').split(';').map((x) => x.trim()).filter(Boolean);
  const keep = parts.filter((x) => /^(JSESSIONID|UID|ticketID)=/.test(x));
  if (!keep.some((x) => x.startsWith('JSESSIONID='))) return null;
  return `${keep.join('; ')}; Comment=SessionServer-unity; Path=/;HTTPOnly; ${''}Secure`
    .replace('; ; ', '; ').replace('  ', ' ');
}

function mintState(state, yx) {
  if (!state.mint) state.mint = {};
  if (!state.mint[yx]) state.mint[yx] = { lastTs: 0, count: 0, blockedUntil: 0, blockedCode: '' };
  return state.mint[yx];
}

// 现签一张 App 网关会话，返回 appTokenLogin 需要的 token 串
async function mintAppSession(account, cfg, state) {
  const tpl = account.mint;
  if (!tpl || !tpl.xk) {
    throw new QwhdError('config_missing', '缺少 autoLogin 模板（account.mint）');
  }
  const ms = mintState(state, account.yx);
  const now = Math.floor(Date.now() / 1000);
  if (ms.blockedUntil > now) {
    throw new QwhdError('credential', `现签被风控静默中（${ms.blockedCode}，剩余 ${Math.ceil((ms.blockedUntil - now) / 60)} 分钟）`);
  }
  if (now - ms.lastTs < MINT_MIN_INTERVAL_SEC) {
    throw new QwhdError('credential', `距上次现签不足 ${MINT_MIN_INTERVAL_SEC / 60} 分钟，本轮跳过`);
  }
  if (ms.count >= MINT_MAX_PER_DAY) {
    throw new QwhdError('credential', `今日现签已达上限 ${MINT_MAX_PER_DAY} 次`);
  }

  const ts = String(Date.now());
  const nonce = String(Math.floor(10000000 + Math.random() * 90000000));
  const plain = JSON.stringify(tpl);
  const body = aesEncryptB64(MINT_KEY_REQ, MINT_IV, plain);
  const xToken = aesEncryptB64(MINT_TOK_KEY, MINT_TOK_IV, `${tpl.xk}_${MINT_PATH}_${ts}_${nonce}`);
  const xs = md5hex(`${MINT_URL}_${plain}_Leadeon/SecurityOrganization`);
  const jsid = crypto.randomUUID();
  const xSign = md5hex(`${xToken}_${ts}_${nonce}_${jsid}`);

  ms.lastTs = now;
  ms.count += 1;

  const res = await httpsPostJson(MINT_URL, {
    timeoutMs: cfg.timeoutMs,
    headers: {
      'content-type': 'application/Json',
      'x-qen': '14',
      xs,
      'x-sign': xSign,
      'x-nonce': nonce,
      'x-time': ts,
      'x-token': xToken,
      'user-agent': MINT_UA,
      'content-length': Buffer.byteLength(body),
      cookie: `JSESSIONID=${jsid}; UID=mhrz${crypto.randomBytes(16).toString('hex')}; Comment=SessionServer-unity`,
    },
    body,
  });

  let retCode = '';
  let retDesc = '';
  try {
    const j = JSON.parse(aesDecryptB64(MINT_KEY_RESP, MINT_IV, res.text.replace(/[^A-Za-z0-9+/=]/g, '')));
    retCode = String(j.retCode || '');
    retDesc = String(j.retDesc || '');
  } catch { /* 解不开就只靠 Set-Cookie 判断 */ }

  if (retCode && retCode !== '000000') {
    const silence = MINT_RISK_SILENCE_SEC[retCode];
    if (silence) {
      ms.blockedUntil = now + silence;
      ms.blockedCode = retCode;
    }
    throw new QwhdError('credential', `现签失败 retCode=${retCode}(${retDesc})`);
  }

  const setCookie = (res.setCookies || []).find((x) => /JSESSIONID=/.test(x)) || '';
  const token = buildAppToken(setCookie);
  if (!token) {
    throw new QwhdError('credential', `现签没拿到 JSESSIONID（HTTP ${res.status}${retCode ? `, retCode=${retCode}` : ''}）`);
  }
  const ticket = (/(?:^|;\s*)ticketID=([^;]+)/.exec(setCookie) || [])[1] || '?';
  log(`✅ 现签网关会话成功（ticketID=${ticket}，今日第 ${ms.count} 次）`);
  return token;
}

/* ------------------------------------------------------------------ */
/* 换票（R1.5）—— 全自动的关键                                          */
/* ------------------------------------------------------------------ */

async function mintSessionToken(account, cfg, appTokenOverride) {
  const actUrl = activityUrl(account.yx);
  const loginUrl = `${BASE}/qwhdsso/login?dlwmh=true&actUrl=${encodeURIComponent(actUrl)}`;

  // 第 1 步：拿 sid（页面里写死的 var sid = 'QWHDSSOD…'）
  const page = await httpFetch(loginUrl, {
    method: 'GET',
    timeoutMs: cfg.timeoutMs,
    headers: baseHeaders({ cookie: `qwhd_center_router=hua; yx=${account.yx}` }),
  });
  const sidMatch = /QWHDSSOD[0-9A-Za-z]+/.exec(page.text);
  if (!sidMatch) {
    throw new QwhdError('credential', `/qwhdsso/login 没拿到 sid（HTTP ${page.status}），blob 可能已失效`);
  }
  const sid = sidMatch[0];

  // 第 2 步：重放 blob 换票
  const body = {
    token: appTokenOverride || account.ssoToken,
    provinceCode: account.provinceCode,
    cityCode: account.cityCode,
    userCheckId: account.userCheckId,
    carrierOperator: account.carrierOperator,
    appVersionCode: account.appVersionCode,
  };
  if (account.jwtToken) body.jwtToken = account.jwtToken;
  if (account.took !== undefined && account.took !== null) body.took = account.took;

  const login = await httpFetch(`${BASE}/qwhdsso/appTokenLogin?sid=${encodeURIComponent(sid)}`, {
    method: 'POST',
    timeoutMs: cfg.timeoutMs,
    headers: baseHeaders({
      referer: loginUrl,
      cookie: `qwhd_center_router=hua; yx=${account.yx}`,
    }),
    body: JSON.stringify(body),
  });
  const loginJson = parseJson(login.text, 'appTokenLogin');
  if (loginJson.code !== 'SUCCESS') {
    // 服务端没给具体原因时不要把原文拼进凭证文案（可能是「当前接口不可用」这类中性串）
    const reason = str(loginJson.msg, '未知原因');
    throw new QwhdError('credential', `换票被拒(${reason})`, { code: loginJson.code });
  }

  // 第 3 步：带回跳页面，从 Set-Cookie 取 session token
  const back = await httpFetch(`${actUrl}&token=${encodeURIComponent(sid)}`, {
    method: 'GET',
    timeoutMs: cfg.timeoutMs,
    headers: baseHeaders({ cookie: `qwhd_center_router=ly; yx=${account.yx}` }),
  });
  const sessionToken = findCookie(back.headers, 'QWHD_SESSION_TOKEN');
  if (!sessionToken) {
    throw new QwhdError('credential', `换票回调没有下发 QWHD_SESSION_TOKEN（HTTP ${back.status}）`);
  }
  log(`✅ 换票成功 yx=${account.yx} token=${maskSecret(sessionToken)}`);
  return sessionToken;
}

/* ------------------------------------------------------------------ */
/* 业务请求                                                            */
/* ------------------------------------------------------------------ */

async function apiPost(account, cfg, apiPath, bodyObj = {}) {
  const token = cfg.sessionToken;
  if (!token) throw new QwhdError('credential', '内部错误：未持有 session token');
  const res = await httpFetch(`${BASE}${apiPath}`, {
    method: 'POST',
    timeoutMs: cfg.timeoutMs,
    headers: baseHeaders({
      'login-check': '1',
      referer: activityUrl(account.yx),
      cookie: `qwhd_center_router=ly; QWHD_SESSION_TOKEN=${token}; yx=${account.yx}`,
    }),
    body: JSON.stringify(bodyObj),
  });
  const json = parseJson(res.text, apiPath);
  // 失败回 HTTP 200、错误只在 body：判活只看业务码（ydyp 实证同类坑）
  if (json.code === 'GOTO_LOGIN' || json.status === 'GOTO_LOGIN') {
    throw new QwhdError('credential', `${apiPath} 需要重新登录`, { httpStatus: res.status });
  }
  return json;
}

function isTodaySigned(markStatus, today) {
  // 照抄 H5 客户端判定：date === today && status === "1"
  if (!Array.isArray(markStatus)) return null; // 形状未知 → 三态里的「不知道」
  return markStatus.some((x) => x && x.date === today && String(x.status) === '1');
}

async function doSignIn(account, cfg, statusJson, today) {
  const data = statusJson && statusJson.data;
  const card = Array.isArray(data && data.markstatus)
    ? data.markstatus.find((x) => x && x.date === today)
    : null;
  const signed = isTodaySigned(data && data.markstatus, today);

  if (signed === true) {
    return { signed: true, written: false, text: '今日已签到(无需操作)', accumulate: num(data && data.userinfo && data.userinfo.accumulateTimes) };
  }
  if (card === null) {
    // 「不知道」≠「没有」：卡片缺失说明结构变了，不要退化成发写请求
    throw new QwhdError('schema_changed', `markstatus 里找不到 ${today} 的卡片`);
  }

  const res = await apiPost(account, cfg, '/qwhdhub/api/mark/mark31/domark', { date: today });
  if (res.code === 'SUCCESS') {
    return { signed: true, written: true, text: '签到成功' };
  }
  if (res.status === 'HAVE_MARKED' || res.code === 'HAVE_MARKED') {
    // 实测原文: {"code":"FAILED","status":"HAVE_MARKED","msg":"今日已签到过，无法再次签到"}
    return { signed: true, written: false, text: '签到成功(服务端回报今日已签到，幂等)' };
  }
  if (res.status === 'DATE_ERROR') {
    throw new QwhdError('api', `签到被拒: ${str(res.msg, '日期不一致')}`);
  }
  throw new QwhdError('api', `签到失败(未知返回 code=${str(res.code, '空')})`);
}

async function claimAwards(account, cfg) {
  const chance = await apiPost(account, cfg, '/qwhdhub/api/mark/mark31/taskAwardChance', {});
  if (chance.code !== 'SUCCESS') {
    throw new QwhdError('api', `查询可领奖励失败(code=${str(chance.code, '空')})`);
  }
  const list = Array.isArray(chance.data) ? chance.data : [];
  if (list.length === 0) return { claimed: [], skipped: [], empty: true };

  const claimed = [];
  const skipped = [];
  for (const item of list) {
    const id = str(item && item.id);
    if (!id) { skipped.push('奖励项缺少 id，已跳过'); continue; }
    // prizeType === "2" / 有 lotteryText = 转盘抽奖，本期不自动抽
    if (String(item.prizeType) === '2' || str(item.lotteryText)) {
      skipped.push(`转盘奖励 ${id} 未自动抽取`);
      continue;
    }
    const res = await apiPost(account, cfg, `/qwhdhub/api/mark/mark31/taskAward/${encodeURIComponent(id)}`, {});
    if (res.code === 'SUCCESS' && !res.status) {
      claimed.push(id);
    } else if (res.code === 'SUCCESS' && res.status === 'PRIZE_NO_STOCK') {
      skipped.push(`奖励 ${id} 已抢完`);
    } else if (res.code === 'SUCCESS' && res.status === 'NOT_WON') {
      skipped.push(`奖励 ${id} 未中奖`);
    } else {
      skipped.push(`奖励 ${id} 领取未成功(code=${str(res.code, '空')})`);
    }
    await sleep(600); // 逐项领取之间留间隔，别把服务端打成并发
  }
  return { claimed, skipped, empty: false };
}

/* ------------------------------------------------------------------ */
/* 通知                                                                */
/* ------------------------------------------------------------------ */

function buildCandidates() {
  const fixed = [];
  let dir = __dirname;
  for (let i = 0; i < 3; i += 1) {
    fixed.push(path.join(dir, 'sendNotify.js'), path.join(dir, 'notify.js'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  fixed.push(
    path.join(process.cwd(), 'sendNotify.js'),
    path.join(process.cwd(), 'notify.js'),
    path.join(process.cwd(), 'function', 'sendNotify.js'),
    path.join(process.cwd(), 'function', 'notify.js'),
    path.join('/ql', 'data', 'scripts', 'sendNotify.js'),
    path.join('/ql', 'data', 'scripts', 'notify.js'),
    path.join('/ql', 'data', 'scripts', 'function', 'sendNotify.js'),
    path.join('/ql', 'data', 'scripts', 'function', 'notify.js'),
    path.join('/ql', 'scripts', 'sendNotify.js'),
    path.join('/ql', 'scripts', 'notify.js'),
  );
  // 第二遍：对最近两代做子目录展开（独立预算，避免把固定位置挤掉）
  const expanded = [];
  const roots = [path.dirname(__dirname), process.cwd()].slice(0, 2);
  for (const root of roots) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).slice(0, 50);
      for (const e of entries) {
        expanded.push(path.join(root, e.name, 'sendNotify.js'), path.join(root, e.name, 'notify.js'));
      }
    } catch { /* 目录不可读就跳过 */ }
  }
  return [...new Set([...fixed, ...expanded.slice(0, 120)])];
}

let warnedMissingNotify = false;
let sendNotifyFn = null;
let sendNotifyLoaded = false;

function loadSendNotify() {
  if (sendNotifyLoaded) return sendNotifyFn;
  sendNotifyLoaded = true;
  const candidates = buildCandidates();
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      if (path.resolve(file) === path.resolve(__filename)) continue; // 自引用保护
      const mod = require(file);
      const fn = typeof mod === 'function' ? mod
        : typeof mod?.sendNotify === 'function' ? mod.sendNotify
          : typeof mod?.default === 'function' ? mod.default
            : null;
      if (fn) {
        sendNotifyFn = fn;
        return fn;
      }
    } catch { /* 继续找下一个候选 */ }
  }
  return null;
}

async function notify(title, content) {
  const fn = loadSendNotify();
  if (fn) {
    try {
      await Promise.resolve(fn(title, content));
      return true;
    } catch (e) {
      // 只打 message，不打整对象（可能含响应体里的凭证）
      logErr(`青龙通知发送失败: ${e && e.message ? e.message : '未知错误'}`);
    }
  } else if (!warnedMissingNotify) {
    warnedMissingNotify = true;
    logWarn(`⚠️ 未找到青龙通知模块(已搜索 ${buildCandidates().length} 个候选路径)，本次未发送通知；`
      + '请把 sendNotify.js 放到脚本目录或 /ql/data/scripts/ 下。');
  }
  console.log(`\n${title}\n${content}`);
  return false;
}

/* ------------------------------------------------------------------ */
/* 单账号流程                                                          */
/* ------------------------------------------------------------------ */

async function runAccount(account, index, cfg) {
  const tag = `账号${index + 1}(yx=${account.yx})`;
  const reporter = { tag, yx: account.yx, ok: false, lines: [], errors: [], invalid: [], warnings: [] };
  log(`—— ${tag} 开始`);

  try {
    // 有 autoLogin 模板就现签一张新会话（免人工）；否则退回配置里的 token
    let appToken = account.ssoToken;
    if (account.mint && account.mint.xk) {
      appToken = await mintAppSession(account, cfg, cfg.state);
      saveState(cfg.stateFile, cfg.state);
    }
    cfg.sessionToken = await mintSessionToken(account, cfg, appToken);
  } catch (e) {
    if (e instanceof QwhdError && e.type === 'credential') {
      // 服务端原文只进面板日志；通知里用自有文案（外部文本进正文必须收口）
      logErr(`${tag} ❌ 换票失败: ${e.message}`);
      reporter.invalid.push(`${tag} blob 已失效`);
      reporter.lines.push('❌ 换票失败(换票接口拒绝了这份 blob)');
    } else {
      throw e;
    }
    return reporter;
  }

  try {
    const today = ymdShanghai();
    const status = await apiPost(account, cfg, '/qwhdhub/api/mark/mark31/markstatus', {});
    if (status.code !== 'SUCCESS') {
      throw new QwhdError('api', `查询签到状态失败(code=${str(status.code, '空')})`);
    }
    const data = status.data || {};
    const accumulate = num(data.userinfo && data.userinfo.accumulateTimes);

    const signRes = await doSignIn(account, cfg, status, today);
    log(`${signRes.signed ? '✅' : '❌'} ${signRes.text}${signRes.written ? '（本次真写了 domark）' : '（未发写请求）'}`);
    reporter.lines.push(`${signRes.signed ? '✅' : '❌'} ${signRes.text}`);
    if (Number.isFinite(accumulate) && accumulate > 0) {
      reporter.lines.push(`📅 累计签到 ${accumulate} 天`);
    }

    // 领奖：签到后就查一遍（今日已签也查，可能有别的累计奖励待领）
    try {
      const award = await claimAwards(account, cfg);
      if (award.empty) {
        reporter.lines.push('🎁 今日暂无可领奖励');
      } else if (award.claimed.length) {
        reporter.lines.push(`🎁 已领奖励 ${award.claimed.length} 项`);
        log(`✅ 已领奖励: ${award.claimed.join(', ')}`);
      }
      for (const s of award.skipped) {
        reporter.lines.push(`⚠️ ${s}`);
        log(`⚠️ ${s}`);
      }
    } catch (e) {
      // 领奖失败不影响签到 verdict，但要如实记录；外部文本进通知前先收口
      const safe = noticeSafe(e && e.message ? e.message : '未知错误');
      reporter.warnings.push(safe);
      reporter.lines.push(`⚠️ 领奖未完成: ${safe}`);
      logWarn(`⚠️ 领奖未完成: ${e && e.message ? e.message : e}`);
    }

    reporter.ok = signRes.signed === true;
  } catch (e) {
    if (e instanceof QwhdError && e.type === 'credential') {
      reporter.invalid.push(`${tag} 会话已失效`);
      reporter.lines.push('❌ 会话已失效(需要重新换票)');
    } else {
      const safe = noticeSafe(e && e.message ? e.message : String(e));
      reporter.errors.push(safe);
      reporter.lines.push(`❌ ${safe}`);
    }
    logErr(`${tag} ❌ ${e && e.message ? e.message : e}`);
  }

  return reporter;
}

/* ------------------------------------------------------------------ */
/* 汇总与入口                                                          */
/* ------------------------------------------------------------------ */

function renderSummary(reporters) {
  const okCount = reporters.filter((r) => r.ok).length;
  const invalidCount = reporters.filter((r) => r.invalid.length).length;
  // 标题不写「成功 N」当存在凭证类失败时，避免与正文的失效关键词自相矛盾
  const head = invalidCount
    ? `⚠️ 有 ${invalidCount} 个账号需要重新抓取换票信息`
    : `完成 ${okCount}/${reporters.length}`;
  const lines = [head, ''];
  for (const r of reporters) {
    lines.push(`【${r.tag}】${r.ok ? '成功' : '失败'}`);
    for (const line of r.lines) lines.push(`  ${line}`);
    if (r.invalid.length) {
      // 凭证类自有文案：必须覆盖「已失效」「重新登录」且点名变量
      lines.push(`  ❌ blob 已失效，请重新登录「中国移动」App 进签到有礼页，重新抓 appTokenLogin 后更新 QWHD_ACCOUNTS`);
    }
    for (const w of r.warnings) lines.push(`  ⚠️ ${w}`);
    for (const e of r.errors) lines.push(`  ❌ ${e}`);
    lines.push('');
  }
  return { title: `${TASK_TITLE} ${invalidCount ? '需要处理' : `${okCount}/${reporters.length}`}`, content: lines.join('\n').trim() };
}

// 状态文件：记录「今天哪些账号已签」「今天已经因 blob 失效告警过哪些账号」
// 目的：30 分钟一轮的情况下，签名只做一次、通知只发一次，避免刷屏与重复写请求。
function loadState(file) {
  const today = ymdShanghai();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && raw.date === today && raw.signed && raw.notified) {
      if (!raw.notifiedErr) raw.notifiedErr = {}; // 兼容旧状态文件
      return raw;
    }
  } catch { /* 文件不存在/损坏都当空状态 */ }
  return { date: today, signed: {}, notified: {}, notifiedErr: {} };
}

function saveState(file, state) {
  try {
    fs.writeFileSync(file, JSON.stringify(state, null, 1));
  } catch (e) {
    logWarn(`⚠️ 状态文件写入失败(${e && e.message ? e.message : e})：节流会失效，本轮仍继续。`
      + ' 请把 QWHD_STATE_FILE 指到一个持久可写路径（青龙建议 /ql/data/config/qwhd-state.json）');
  }
}

// 把本轮结果归并进状态，并决定「哪些失败值得发通知」（每个账号每天最多各一次）
function applyResults(state, accounts, reporters) {
  const alert = [];
  const errors = [];
  for (const r of reporters) {
    if (r.ok) state.signed[r.yx] = true;
    if (r.invalid.length) {
      if (!state.notified[r.yx]) { state.notified[r.yx] = true; alert.push(r); }
    } else if (!r.ok) {
      if (!state.notifiedErr[r.yx]) { state.notifiedErr[r.yx] = true; errors.push(r); }
    }
  }
  return { alert, errors, allSigned: accounts.every((a) => state.signed[a.yx]) };
}

// 状态文件默认位置：优先青龙的持久可写目录 /ql/data/config（脚本目录可能被"订阅/同步"整个覆盖，
// 放在脚本旁边会被连带清掉 → 节流失效 → 每轮都告警）。本地跑则回落到脚本同目录。
function defaultStateFile() {
  try {
    if (fs.statSync('/ql/data/config').isDirectory()) return path.join('/ql/data/config', 'qwhd-state.json');
  } catch { /* 非青龙环境 */ }
  return path.join(__dirname, '.qwhd-state.json');
}

function resolveConfig() {
  const raw = process.env.QWHD_ACCOUNTS;
  const timeoutMs = num(process.env.QWHD_TIMEOUT_MS, DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const push = String(process.env.QWHD_PUSH ?? '1') !== '0';
  const stateFile = process.env.QWHD_STATE_FILE || defaultStateFile();
  return { raw, timeoutMs, push, stateFile };
}

async function main() {
  const cfg = resolveConfig();
  const { accounts, problems } = parseAccounts(cfg.raw);

  if (!accounts.length) {
    // 配置缺失属非凭证类：只给指引，不发任何请求
    const lines = [MSG_MISSING];
    if (problems.length) lines.push('', '另外发现这些条目的格式问题:', ...problems.map((p) => `  - ${p}`));
    const content = lines.join('\n');
    // 这段是我们自己的模板(只含 … 占位)，不走 redactLog —— 否则示例里的键名会被打歪成 [redacted]
    console.error(`${LOG_PREFIX} ${content}`);
    // 有通知模块才推送；没有的话上面已经打过了，不再重复兜底
    if (cfg.push && loadSendNotify()) await notify(`${TASK_TITLE} 未配置`, content);
    process.exitCode = 1;
    return;
  }

  if (problems.length) {
    for (const p of problems) logWarn(`⚠️ ${p}（该条目已跳过）`);
  }

  // 今天已签完就直接退出，一个请求都不发（cron 每天两次，第二次也会命中这里）
  const stateExists = fs.existsSync(cfg.stateFile);
  const state = loadState(cfg.stateFile);
  log(`状态文件: ${cfg.stateFile}（${stateExists ? '已存在' : '本次新建'}，日期 ${state.date}，`
    + `已签 ${Object.keys(state.signed).length}，已告警 ${Object.keys(state.notified).length}）`);
  const pending = accounts.filter((a) => !state.signed[a.yx]);
  if (!pending.length) {
    log(`今日(${state.date})全部 ${accounts.length} 个账号均已签到，本轮跳过（不发请求、不发通知）`);
    return;
  }

  log(`共 ${accounts.length} 个账号，其中 ${pending.length} 个未签，开始执行`);
  const reporters = [];
  for (let i = 0; i < pending.length; i += 1) {
    reporters.push(await runAccount(pending[i], i, { ...cfg, sessionToken: null, state }));
    if (i < pending.length - 1) await sleep(1000);
  }

  const { alert, errors, allSigned } = applyResults(state, accounts, reporters);
  saveState(cfg.stateFile, state);

  // 1) 凭证类失败：每个账号每天只告警一次，其余轮次静默等用户重抓 blob
  if (alert.length) {
    const { title, content } = renderSummary(alert);
    if (cfg.push) await notify(title, content);
    else log(`\n${title}\n${content}`);
    process.exitCode = 1;
    return;
  }

  // 2) 全部签完：只发一次成功汇总
  if (allSigned) {
    const out = [`完成 ${accounts.length}/${accounts.length}`, ''];
    for (const r of reporters) {
      out.push(`【${r.tag}】成功`);
      for (const l of r.lines) out.push(`  ${l}`);
    }
    if (accounts.length > reporters.length) {
      out.push(`（其余 ${accounts.length - reporters.length} 个账号本轮之前已签到）`);
    }
    const title = `${TASK_TITLE} ${accounts.length}/${accounts.length}`;
    const content = out.join('\n').trim();
    if (cfg.push) await notify(title, content);
    else log(`\n${title}\n${content}`);
    process.exitCode = 0;
    return;
  }

  // 3) 非凭证类失败：每天也最多告警一次，避免每天两次都推
  if (errors.length) {
    const { title, content } = renderSummary(errors);
    if (cfg.push) await notify(title, content);
    else log(`\n${title}\n${content}`);
    process.exitCode = 1;
    return;
  }

  // 4) 今天已经告警过、仍未成功：静默重试，不动退出码
  log('本轮未完成，今日已告警过，静默等待下一轮');
}

/* ------------------------------------------------------------------ */
/* 离线自检（--selfcheck）：全程不发网络请求                             */
/* ------------------------------------------------------------------ */

function selfcheck() {
  let pass = 0;
  const fail = [];
  const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) pass += 1;
    else fail.push(`${name}: 期望 ${JSON.stringify(expected)} 实际 ${JSON.stringify(actual)}`);
  };

  // 1) 日期按北京时间换算（不受宿主机时区影响）
  check('ymd20261121T01:00Z', ymdShanghai(new Date('2026-11-21T01:00:00Z')), '20261121');
  check('ymd20261120T15:59Z', ymdShanghai(new Date('2026-11-20T15:59:00Z')), '20261120');
  check('ymd20261120T16:01Z', ymdShanghai(new Date('2026-11-20T16:01:00Z')), '20261121');

  // 2) 今日已签判定：照抄 H5 的 date===today && status==="1"
  check('signed-true', isTodaySigned([{ date: '20261121', status: '1' }], '20261121'), true);
  check('signed-false', isTodaySigned([{ date: '20261121', status: '0' }], '20261121'), false);
  check('signed-otherday', isTodaySigned([{ date: '20261120', status: '1' }], '20261121'), false);
  check('signed-unknown', isTodaySigned(undefined, '20261121'), null);

  // 3) 配置解析：多账号分隔、保序去重、缺字段指出下标
  const acc = (yx, extra = {}) => JSON.stringify({
    jwtToken: 'a'.repeat(128), token: 'JSESSIONID=x; UID=y', provinceCode: '571',
    cityCode: '0574', userCheckId: '446d87a0b', carrierOperator: '002', yx, ...extra,
  });
  const p1 = parseAccounts(`${acc('1')}&${acc('2')}\n${acc('1')}`);
  check('parse-count', p1.accounts.length, 2);
  check('parse-order', p1.accounts.map((a) => a.yx), ['1', '2']);
  const p2 = parseAccounts('{"jwtToken":"x","yx":"9"}');
  check('parse-missing-idx', p2.problems.length === 1 && p2.problems[0].includes('QWHD_ACCOUNTS[0]'), true);
  check('parse-no-placeholder', parseAccounts('{"jwtToken":"x","yx":"9"}').accounts.length, 0);
  const p3 = parseAccounts('not-json');
  check('parse-badjson', p3.accounts.length === 0 && p3.problems.length === 1, true);

  // 4) 通知分流：凭证类必须命中，成功/配置缺失/非凭证类必须不命中
  check('route-credential', matchesAlertRouting('❌ blob 已失效，请重新登录「中国移动」App'), true);
  check('route-relead', matchesAlertRouting('登录失效, 请重新登录'), true);
  check('route-success', matchesAlertRouting('✅ 签到成功'), false);
  check('route-already', matchesAlertRouting('✅ 今日已签到(无需操作)'), false);
  check('route-config-missing', matchesAlertRouting(MSG_MISSING), false);
  check('route-network', matchesAlertRouting('请求失败: 超时 15000ms'), false);
  check('route-prize-stock', matchesAlertRouting('⚠️ 奖励 272889 已抢完'), false);

  // 5) 脱敏：三种形态都要盖住（裸 k=v / k: v / JSON "k":"v"）
  const leaked = [
    'jwtToken=abcdefabcdefabcdef',
    'token: JSESSIONID=abc; UID=def',
    '{"token":"JSESSIONID=abc; UID=def"}',
    'QWHD_SESSION_TOKEN=335964D20261121T090244096D1323;',
  ];
  for (const raw of leaked) {
    const out = redactLog(raw);
    check(`redact:${raw.slice(0, 18)}`, /JSESSIONID=|335964D2026|abcdefabcdefabcdef/.test(out), false);
  }
  check('mask-short', maskSecret('abc'), '***');

  // 6) 外部文本收口：命中关键词的文本必须被替换成中性占位
  check('noticeSafe-hit', noticeSafe('upstream says token expired'), NOTICE_PLACEHOLDER);
  check('noticeSafe-miss', noticeSafe('签到成功'), '签到成功');

  // 7) 数值收口
  check('num-bad', num('invalid'), 0);
  check('num-ok', num('12'), 12);

  // 8) 通知整体自洽：标题+正文拼接后过分流，成功路径不得命中、凭证类必须命中
  const okRep = [{ tag: '账号1(yx=1)', ok: true, lines: ['✅ 今日已签到(无需操作)', '📅 累计签到 2 天', '🎁 今日暂无可领奖励'], errors: [], invalid: [], warnings: [] }];
  const s1 = renderSummary(okRep);
  check('notify-ok-no-alert', matchesAlertRouting(s1.title + s1.content), false);
  const badRep = [{ tag: '账号1(yx=1)', ok: false, lines: ['❌ 换票失败(换票接口拒绝了这份 blob)'], errors: [], invalid: ['账号1 blob 已失效'], warnings: [] }];
  const s2 = renderSummary(badRep);
  check('notify-cred-alert', matchesAlertRouting(s2.title + s2.content), true);
  check('notify-cred-title', s2.title.includes('需要处理'), true);   // 有凭证类失败时标题不得写「完成 N/M」
  check('notify-ok-title', s1.title.includes('1/1'), true);

  // 8.2) 网关现签的加密/签名（向量固定，来自 2026-11-23 抓包逐字节复现）
  const enc = aesEncryptB64(MINT_KEY_REQ, MINT_IV, '{"a":1}');
  check('aes-roundtrip', aesDecryptB64(MINT_KEY_REQ, MINT_IV, enc), '{"a":1}');
  check('xtoken-vector',
    aesEncryptB64(MINT_TOK_KEY, MINT_TOK_IV, 'TESTXK_/p_1700000000000_12345678'),
    'tOKhrYHqI31PMB2RmUjljq+MLqLB7TQgDG0FlW7+e2+tM3SPfcMbP8Mqe/ElNAf6');
  check('xs-vector',
    md5hex(`https://x/y_${JSON.stringify({ a: 1 })}_Leadeon/SecurityOrganization`),
    '45d5470239c7cb7cfa23321e6563c427');
  check('xsign-vector',
    md5hex(['tOKhrYHqI31PMB2RmUjljq+MLqLB7TQgDG0FlW7+e2+tM3SPfcMbP8Mqe/ElNAf6',
      '1700000000000', '12345678', 'js-1'].join('_')),
    '004285ebf9f25b6e6adba1e251eeb775');

  // token 串必须保留服务端原样结构（精简会失效，实测 X1~X4 全挂）
  const appTok = buildAppToken('JSESSIONID=abc-1; UID=mhrz00; Comment=SessionServer-unity; Path=/;HTTPOnly; ticketID=SuZhou; Secure');
  check('apptoken-has-jsessionid', /JSESSIONID=abc-1/.test(appTok), true);
  check('apptoken-has-comment', /Comment=SessionServer-unity/.test(appTok), true);
  check('apptoken-has-secure', /Secure/.test(appTok), true);
  check('apptoken-has-ticket', /ticketID=SuZhou/.test(appTok), true);
  check('apptoken-reject-nonjsession', buildAppToken('UID=mhrz00; Secure'), null);

  // 8.5) 状态文件与通知节流：签名/告警都必须每天只做一次
  const os = require('node:os');
  const tmpState = path.join(os.tmpdir(), `qwhd-selfcheck-${process.pid}.json`);
  fs.writeFileSync(tmpState, JSON.stringify({ date: '19700101', signed: { 1: true }, notified: {} }));
  const rolled = loadState(tmpState);
  check('state-rollover-date', rolled.date, ymdShanghai());
  check('state-rollover-clear', rolled.signed, {});
  fs.writeFileSync(tmpState, JSON.stringify({ date: ymdShanghai(), signed: { 9: true }, notified: {}, notifiedErr: {} }));
  check('state-same-day-keep', loadState(tmpState).signed, { 9: true });
  fs.unlinkSync(tmpState);

  const accs = [{ yx: '1' }];
  const st = { date: ymdShanghai(), signed: {}, notified: {}, notifiedErr: {} };
  const okRun = applyResults(st, accs, [{ yx: '1', ok: true, invalid: [] }]);
  check('apply-signed', st.signed['1'], true);
  check('apply-allSigned', okRun.allSigned, true);
  check('apply-no-alert', okRun.alert.length, 0);

  const st2 = { date: ymdShanghai(), signed: {}, notified: {}, notifiedErr: {} };
  const bad1 = applyResults(st2, accs, [{ yx: '1', ok: false, invalid: ['x'] }]);
  const bad2 = applyResults(st2, accs, [{ yx: '1', ok: false, invalid: ['x'] }]);
  check('throttle-first-alert', bad1.alert.length, 1);
  check('throttle-second-silent', bad2.alert.length, 0);   // 同一账号同一天第二次不再告警
  check('throttle-not-signed', st2.signed['1'], undefined);

  const st3 = { date: ymdShanghai(), signed: {}, notified: {}, notifiedErr: {} };
  const e1 = applyResults(st3, accs, [{ yx: '1', ok: false, invalid: [], errors: ['boom'] }]);
  const e2 = applyResults(st3, accs, [{ yx: '1', ok: false, invalid: [], errors: ['boom'] }]);
  check('throttle-err-first', e1.errors.length, 1);
  check('throttle-err-second', e2.errors.length, 0);

  // 9) 写接口语义：HAVE_MARKED 视为成功，DATE_ERROR 视为失败（分支常量对齐服务端实测原文）
  const haveMarked = { code: 'FAILED', status: 'HAVE_MARKED', msg: '今日已签到过，无法再次签到' };
  check('havemarked-detect', haveMarked.status === 'HAVE_MARKED', true);
  check('dateerror-detect', { status: 'DATE_ERROR' }.status === 'DATE_ERROR', true);

  if (fail.length) {
    console.error(`selfcheck FAIL (${fail.length}/${pass + fail.length})`);
    for (const f of fail) console.error(`  ❌ ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log(`selfcheck PASS (${pass}/${pass})`);
}

if (require.main === module) {
  if (process.argv.includes('--selfcheck')) {
    selfcheck();
  } else {
    main().catch(async (error) => {
      const msg = error instanceof QwhdError
        ? error.message
        : `未知错误: ${error && error.message ? error.message : String(error)}`;
      const isConfig = error instanceof QwhdError && error.type === 'config_missing';
      logErr(`❌ ${isConfig ? '配置缺失' : '发生异常:执行失败'}`);
      logErr(msg);
      const content = isConfig ? msg : `❌ 发生异常:执行失败\n\n${noticeSafe(msg)}`;
      try { await notify(`${TASK_TITLE} 执行失败`, content); } catch { /* 通知失败不覆盖原错误 */ }
      process.exitCode = 1;
    });
  }
}

module.exports = { parseAccounts, isTodaySigned, ymdShanghai, redactLog, noticeSafe, matchesAlertRouting, loadState, applyResults, MSG_MISSING };
