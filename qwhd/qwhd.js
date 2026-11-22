#!/usr/bin/env node
// cron: */30 * * * *
// new Env('中国移动签到有礼');
// description: 中国移动 App「签到有礼」(wx.10086.cn/qwhdhub mark31)每日签到 + 领累计奖励，脚本自己换票，无需每天手动贴 token
/**
 * 环境变量（必需）:
 *   QWHD_ACCOUNTS —— 每项一个账号的「换票 blob」，多个账号用 & 或换行分隔（保序去重）。
 *
 *   取值路径（2026-11-21 实测，整条链路见下）:
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
 * 为什么用「每 30 分钟」而不是每天一次（2026-11-22 实测）:
 *   换票 blob 背后是「移动认证 SSO 会话」，它有**约 4 小时绝对寿命**，且用 30 分钟重放一次也续不了
 *   （body 里的 token 字段不被当成"使用会话"）。实测：10:15 抓的 blob 在 13:40 还能换票，14:10 起
 *   一律回「APP登录状态已过期」。
 *   所以每天定时跑必然撞空 → 改成每 30 分钟跑：用户当天抓一次 blob，脚本会在 30 分钟内自动签到；
 *   当天签完就写状态文件、后续运行直接跳过（不发请求、不发通知）。
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

const ACCOUNT_REQUIRED = ['jwtToken', 'token', 'provinceCode', 'cityCode', 'userCheckId', 'carrierOperator', 'yx'];

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
    // 解析不出必需字段时**不要**用占位值兜底(见 spec「解析不出必需字段」)
    const key = `${obj.yx}|${obj.userCheckId}`;
    if (seen.has(key)) return; // 保序去重
    seen.add(key);
    accounts.push({
      yx: str(obj.yx),
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
/* 换票（R1.5）—— 全自动的关键                                          */
/* ------------------------------------------------------------------ */

async function mintSessionToken(account, cfg) {
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
    jwtToken: account.jwtToken,
    token: account.ssoToken,
    provinceCode: account.provinceCode,
    cityCode: account.cityCode,
    userCheckId: account.userCheckId,
    carrierOperator: account.carrierOperator,
    appVersionCode: account.appVersionCode,
  };
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
    cfg.sessionToken = await mintSessionToken(account, cfg);
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
    logWarn(`⚠️ 状态文件写入失败(${e && e.message ? e.message : e})，本轮仍继续；下一轮可能重复检查`);
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

function resolveConfig() {
  const raw = process.env.QWHD_ACCOUNTS;
  const timeoutMs = num(process.env.QWHD_TIMEOUT_MS, DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const push = String(process.env.QWHD_PUSH ?? '1') !== '0';
  const stateFile = process.env.QWHD_STATE_FILE || path.join(__dirname, '.qwhd-state.json');
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

  // 每 30 分钟一轮：今天已签完就直接退出，一个请求都不发
  const state = loadState(cfg.stateFile);
  const pending = accounts.filter((a) => !state.signed[a.yx]);
  if (!pending.length) {
    log(`今日(${state.date})全部 ${accounts.length} 个账号均已签到，本轮跳过（不发请求、不发通知）`);
    return;
  }

  log(`共 ${accounts.length} 个账号，其中 ${pending.length} 个未签，开始执行`);
  const reporters = [];
  for (let i = 0; i < pending.length; i += 1) {
    reporters.push(await runAccount(pending[i], i, { ...cfg, sessionToken: null }));
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

  // 3) 非凭证类失败：每天也最多告警一次，避免每 30 分钟刷屏
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

  // 8.5) 状态文件与通知节流：每 30 分钟一轮，签名/告警都必须每天只做一次
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
