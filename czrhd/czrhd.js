#!/usr/bin/env node
// cron: 0 8 * * 3
// new Env('中国移动周三充值日抢券');
// description: 中国移动 App「周三充值日」整点抢充值券（drawPrize），每周三 8:00 换票 → 查状态 → 抢券 → 通知；不碰充值下单
/**
 * 这条活动到底是什么（官方规则原文，2026-11-25 用户截图）
 *   「一、周三充值整点抢 —— 活动期间，每周三 8:00（新疆、西藏 10:00），中国移动用户
 *     （不含中国港澳台地区）进入活动页面可参与领取中国移动 APP 充值福利，
 *     **每用户每周三活动均可参与一次**，有机会领取 2 元至 88 元不等的充值券，
 *     数量有限，先到先得，发完即止。」
 *   → 一周只有一场，每户每周一次；中的是 2~88 元不等的充值立减/折扣/加享券。
 *
 * 范围（有意做窄）
 *   只做这一件事：wx.10086.cn/hlwyxhdhub/api/wedrecharge/drawPrize。
 *   拿到券后请自己到中国移动 App 里用券充值。**不打卡、不领无忧券/权益券、绝不下单支付**
 *   （充值在 App 原生收银台，属资金操作，风险不该由脚本承担）。
 *
 * 环境变量（必需）
 *   CZRHD_ACCOUNTS  每项一个账号的「换票 blob」，多个账号用 & 或换行分隔（保序去重）。
 *     抓法（2026-11-25 实测）:
 *       1. 打开「中国移动」App → 进「周三充值日」活动页
 *       2. 抓包工具里找 POST https://wx.10086.cn/qwhdsso/appTokenLogin?sid=…
 *       3. 「复制为 cURL」，取 body 整个 JSON，再补一个字段 "yx"
 *          （yx 来自同一次请求 cookie 里的 `yx=…`，也出现在活动页 URL 的 `yx=` 参数里）
 *       形如: {"jwtToken":"…","token":"JSESSIONID=…; UID=…; ticketID=…","provinceCode":"571",
 *              "cityCode":"0574","userCheckId":"446d87a0b","carrierOperator":"002",
 *              "appVersionCode":"12.5.7","yx":"9000355298"}
 *     这个 blob 里的 token 可**重放换票**，但寿命很短 —— 实测 2026-11-25 那份只换了几次票就报
 *     「APP登录状态已过期」，之后再也换不出来（连用真 token 也不行）。所以推荐下面这条：
 *
 *     【推荐】把 qwhd 里已经配好的 autoLogin 模板整块拷进本账号的 "mint" 字段：
 *       {"yx":"9000355298","provinceCode":"571",…,"mint":{"xk":"…","reqBody":{"cellNum":"…",…}}}
 *     有 mint 时每次运行先现签一张新 App 会话，永久免人工；
 *     风控纪律与 qwhd 一致：两次至少隔 10 分钟、每天最多 3 次（正好=三场）。
 *     ⚠️ 千万别拿改坏的 token 去试换票 —— 实测会让服务端把整张票作废（连真 token 一起死）。
 *
 * 环境变量（可选，前缀 CZRHD_）
 *   CZRHD_WRITE=1           0 = 只读模式：只查状态、不发抽奖请求（默认 1）
 *   CZRHD_PUSH=1            是否发青龙通知（默认 1）
 *   CZRHD_TIMEOUT_MS=15000  单请求超时（毫秒）
 *   CZRHD_STATE_FILE=<路径>  状态文件，默认 /ql/data/config/.czrhd-state.json（目录不存在则落到脚本目录）
 *   CZRHD_RETRY=20          抢不到时的重试次数（默认 20，配 3s 间隔 ≈ 60s 抢券窗口）
 *   CZRHD_RETRY_MS=3000     重试间隔（默认 3 秒）—— 先到先得，窗口短，靠短间隔磨开闸误差
 *   CZRHD_FORCE=0           1 = 非周三也发写请求（排障用；默认非周三只查不发，省得白消耗）
 *   CZRHD_PAGE_ID / CZRHD_CHANNEL_ID / CZRHD_RED_CODE  活动页参数（一般不用改）
 *
 * 为什么 cron 是「每周三 8:00 一次」而不是高频
 *   官方规则就一场：每周三 8:00（新疆/西藏 10:00），每户每周一次，先到先得。
 *   高频跑没意义（重复参与只会回 160003），在 8:00 之外跑也只是白给风控看。
 *   8:00 触发后靠进程内短间隔重试（默认 3s × 20）磨过开闸瞬间的网络误差与分批放券。
 *   ⚠️ 账号属新疆/西藏的话请自己把 cron 改成 10:00（脚本不探省份时区）。
 *   ⚠️ 前端 bundle 里 seckillTime 兜底 [8,12,18] 曾被误读成「一天三场」—— 那是错的，已作废。
 *
 * 状态机（rdStatus，实测自前端 bundle 的 drawPrize 模块）
 *   0 bargain 砍价 / 1 start 可以开抢 / 2 noChance 无抽奖次数 / 3 grant 发放中 /
 *   4 goUse 已中奖待使用 / 5 used 已使用 / 6 noWeek 非活动日 /
 *   7 countDown 未到开抢时间 / 10 locked 锁定
 *   只有 1(start) 确定可以开抢；3/4/5 也会探一次 drawPrize —— 「周三 8:00 重置后 rdStatus 会不会回到 1」
 *   尚未实测（本周三已在 10:12 用掉），而 160003 是服务端对本周的权威回答、重复探测零副作用。
 *
 * 已实测（2026-11-25，来源见 .trellis/tasks/11-25-cmcc-wed-charge-day/research/wedcz-contract.md）
 *   换票三步: GET /qwhdsso/login → POST /qwhdsso/appTokenLogin → GET <活动页>&token=<sid>
 *             → Set-Cookie: HLWHD_SESSION_TOKEN=<32位>（Max-Age=1800，注意不是 qwhd 的 QWHD_SESSION_TOKEN）
 *   drawPrize 重复参与: {"code":"160003","msg":"已参与过秒杀活动"}
 *   进页面约 7 秒就自动发券 → 说明 drawPrize 不需要先打卡（打卡只加抽奖次数，不是门槛）
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const LOG_PREFIX = '[czrhd]';
const TASK_TITLE = '中国移动周三充值日抢券';

const BASE = 'https://wx.10086.cn';
const API_PREFIX = `${BASE}/hlwyxhdhub/api/wedrecharge`;
const ACT_PATH = '/hlwyxhdhub/act-wedrecharge/1024101716';
const DEFAULT_PAGE_ID = '1849008675699650560';
const DEFAULT_CHANNEL_ID = 'P00000139873';
const DEFAULT_RED_CODE = 'rec_NofeedHotZoneApp_P00000139873';
const SESSION_COOKIE = 'HLWHD_SESSION_TOKEN';

// App 内 H5 的 UA；服务端不做强校验，保持一致便于排障
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Mobile/15E148/wkwebview leadeon/12.5.7/CMCCIT';

const DEFAULT_TIMEOUT_MS = 15000;

// ---- App 网关「现签会话」（client.app.coc.10086.cn / autoLogin）------------------
// 与 qwhd/qwhd.js 完全同一套：autoLogin 不校验 cookie，只要请求体里的 cellNum（App 内 RSA 加密的
// 手机号）与签名正确，就换发一张全新会话。配一次 autoLogin 明文模板（account.mint）即可永久免人工。
// 为什么必须要有它：静态 blob 里的 token（JSESSIONID 串）**撑不了多久**——
// 实测 2026-11-25 抓的那份只换了几次票就报「APP登录状态已过期」，之后再也换不出来。
const MINT_URL = 'https://client.app.coc.10086.cn/biz-orange/LN/uamonekeylogin/autoLogin';
const MINT_PATH = '/biz-orange/LN/uamonekeylogin/autoLogin';
const MINT_KEY_REQ = Buffer.from('tVkdaRWRY0ZkV1Vr', 'utf8');
const MINT_KEY_RESP = Buffer.from('RYV0hCV1lV25KYVJ', 'utf8');
const MINT_IV = Buffer.from('VjFSQ1ZtVkQxRTlQ', 'utf8');
const MINT_TOK_KEY = Buffer.from('bAIgvwAuA4tbDr9d', 'utf8');
const MINT_TOK_IV = Buffer.from('9791027341711819', 'utf8');
const MINT_UA = 'ChinaMobile/12.5.7 (iPhone; iOS 27.0.1; Scale/3.00)';

// 风控纪律（与 qwhd 一致）：autoLogin 等于一次「App 一键登录」，调多会触发人脸/封 App
const MINT_MIN_INTERVAL_SEC = 600; // 两次现签至少隔 10 分钟
const MINT_MAX_PER_DAY = 3; // 每天最多 3 次 —— 正好对应 8/12/18 三场
const MINT_RISK_SILENCE_SEC = { 233031: 600, 214100: 7200, 214103: 86400, 213245: 7200 };

// 抽奖模块的 rdStatus 语义（照抄前端 bundle，改文案前先核对）
const RD_STATUS = {
  0: 'bargain 砍价中',
  1: 'start 可以开抢',
  2: 'noChance 无抽奖次数',
  3: 'grant 奖励发放中',
  4: 'goUse 已中奖待使用',
  5: 'used 已使用',
  6: 'noWeek 非活动日',
  7: 'countDown 未到开抢时间',
  10: 'locked 锁定',
};

// 业务码
const CODE_OK = '0';
const CODE_ALREADY_JOINED = '160003'; // 已参与过秒杀活动

// 需要脱敏的键（日志与通知都要过一遍）
const SECRET_KEYS = ['jwtToken', 'token', 'cookie', 'authorization', SESSION_COOKIE.toLowerCase()];
// 凭证类文案关键词：下游 Node-RED 按这些词分流「需要人工重抓」
const ALERT_KEYWORDS = '已失效,重新登录,登录失效,token 失效';
const NOTICE_PLACEHOLDER = '⚠️ 已省略一段疑似凭证类文本（原文见面板日志）';

class CzrhdError extends Error {
  constructor(type, message, extra = {}) {
    super(message);
    this.name = 'CzrhdError';
    this.type = type; // credential | network | schema_changed | business
    Object.assign(this, extra);
  }
}

/* ------------------------------------------------------------------ */
/* 日志 & 脱敏                                                          */
/* ------------------------------------------------------------------ */

function maskSecret(secret) {
  const s = String(secret ?? '');
  if (s.length <= 20) return '***';
  return `${s.slice(0, 12)}***${s.slice(-4)}`;
}

function redact(text) {
  let out = String(text ?? '');
  for (const key of SECRET_KEYS) {
    out = out.replace(new RegExp(`("?${key}"?\\s*[:=]\\s*"?)([^",;\\s}]{8,})`, 'gi'),
      (_m, head, val) => `${head}${maskSecret(val)}`);
  }
  return out;
}

function log(msg) { console.log(`${LOG_PREFIX} ${redact(msg)}`); }
function logErr(msg) { console.error(`${LOG_PREFIX} ${redact(msg)}`); }
function logWarn(msg) { console.warn(`${LOG_PREFIX} ${redact(msg)}`); }

function matchesAlertRouting(text) {
  const lower = String(text ?? '').toLowerCase();
  const compact = lower.replace(/\s+/g, '');
  return ALERT_KEYWORDS.split(',').map((k) => k.trim()).filter(Boolean)
    .some((k) => lower.includes(k) || compact.includes(k.replace(/\s+/g, '')));
}

// 外部文本（服务端 msg 等）进通知前逐处收口；自有凭证文案不要过这个函数
function noticeSafe(text) {
  const t = redact(String(text ?? ''));
  return matchesAlertRouting(t) ? NOTICE_PLACEHOLDER : t;
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function str(value, fallback = '') {
  return typeof value === 'string' && value ? value : fallback;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// 服务端按北京时间判场次；固定 +8 偏移自行换算，避开容器时区
function nowShanghai(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600 * 1000);
}

function hhmmShanghai(date = new Date()) {
  const t = nowShanghai(date);
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

const ACCOUNT_REQUIRED = ['provinceCode', 'cityCode', 'userCheckId', 'carrierOperator', 'yx'];

const MSG_MISSING = [
  '❌ 未配置环境变量 CZRHD_ACCOUNTS',
  '请按下面步骤取一份账号配置填进面板:',
  '  1. 打开「中国移动」App → 进入「周三充值日」活动页',
  `  2. 抓包工具里找 POST ${BASE}/qwhdsso/appTokenLogin?sid=…`,
  '  3. 复制该请求体（整个 JSON），再补一个字段 "yx"（取同一次请求 cookie 里的 yx=…）',
  '  4. （推荐）把 qwhd 里已配好的 mint 模板对象也整块拷进来，以后就不用手工重抓',
  '  5. 面板里新建环境变量 CZRHD_ACCOUNTS，多个账号用 & 或换行分隔',
].join('\n');

function splitAccounts(raw) {
  return String(raw || '').split(/[\n&]/).map((s) => s.trim()).filter(Boolean);
}

function parseAccounts(raw) {
  const accounts = [];
  const seen = new Set();
  const problems = [];

  splitAccounts(raw).forEach((text, index) => {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      problems.push(`CZRHD_ACCOUNTS[${index}] 不是合法 JSON: ${e.message}`);
      return;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      problems.push(`CZRHD_ACCOUNTS[${index}] 必须是一个 JSON 对象`);
      return;
    }
    const missing = ACCOUNT_REQUIRED.filter((k) => !str(obj[k]));
    if (missing.length) {
      problems.push(`CZRHD_ACCOUNTS[${index}] 缺少字段: ${missing.join(', ')}`);
      return;
    }
    const mint = obj.mint && typeof obj.mint === 'object' ? obj.mint : null;
    const hasMint = Boolean(mint && str(mint.xk) && mint.reqBody && str(mint.reqBody.cellNum));
    if (!str(obj.token) && !hasMint) {
      problems.push(`CZRHD_ACCOUNTS[${index}] 既没有 token，也没有可用的 mint 模板（需含 xk 与 reqBody.cellNum）`);
      return;
    }
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

function readConfig() {
  const env = process.env;
  const write = str(env.CZRHD_WRITE, '1') !== '0';
  const stateDir = fs.existsSync('/ql/data/config') ? '/ql/data/config' : __dirname;
  return {
    accountsRaw: str(env.CZRHD_ACCOUNTS),
    write,
    push: str(env.CZRHD_PUSH, '1') !== '0',
    timeoutMs: Math.max(3000, num(env.CZRHD_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)),
    stateFile: str(env.CZRHD_STATE_FILE, path.join(stateDir, '.czrhd-state.json')),
    retry: Math.max(0, num(env.CZRHD_RETRY, 20)),
    retryMs: Math.max(1000, num(env.CZRHD_RETRY_MS, 3000)),
    force: str(env.CZRHD_FORCE, '0') === '1',
    pageId: str(env.CZRHD_PAGE_ID, DEFAULT_PAGE_ID),
    channelId: str(env.CZRHD_CHANNEL_ID, DEFAULT_CHANNEL_ID),
    redCode: str(env.CZRHD_RED_CODE, DEFAULT_RED_CODE),
  };
}

function activityUrl(account, cfg) {
  const q = [
    `lc_traceid=${encodeURIComponent(`czrhd${Date.now().toString(36)}`)}`,
    `pageId=${encodeURIComponent(cfg.pageId)}`,
    `channelId=${encodeURIComponent(cfg.channelId)}`,
    `yx=${encodeURIComponent(account.yx)}`,
    `redCode=${encodeURIComponent(cfg.redCode)}`,
  ].join('&');
  return `${BASE}${ACT_PATH}?${q}`;
}

/* ------------------------------------------------------------------ */
/* 状态文件（当天已抽中的记录，避免重复换票撞接口）                        */
/* ------------------------------------------------------------------ */

function loadState(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function saveState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch (e) {
    logWarn(`⚠️ 状态文件写入失败(${e.message})，本次结果不落盘，不影响主流程`);
  }
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
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const res = await fetch(url, { ...options, signal: controller.signal, redirect: 'manual' });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  } catch (e) {
    throw new CzrhdError('network', `请求失败: ${e.name === 'AbortError' ? `超时 ${timeoutMs}ms` : e.message}`);
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
    throw new CzrhdError('schema_changed', `${where} 返回不是 JSON（长度 ${text.length}）`);
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
    req.on('error', (e) => reject(new CzrhdError('network', `请求失败: ${e.code || e.message}`)));
    req.end(body);
  });
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
    throw new CzrhdError('config_missing', '缺少 autoLogin 模板（account.mint）');
  }
  const ms = mintState(state, account.yx);
  const now = Math.floor(Date.now() / 1000);
  if (ms.blockedUntil > now) {
    throw new CzrhdError('throttled', `现签被风控静默中（${ms.blockedCode}，剩余 ${Math.ceil((ms.blockedUntil - now) / 60)} 分钟）`);
  }
  if (now - ms.lastTs < MINT_MIN_INTERVAL_SEC) {
    throw new CzrhdError('throttled', `距上次现签不足 ${MINT_MIN_INTERVAL_SEC / 60} 分钟，本轮跳过`);
  }
  if (ms.count >= MINT_MAX_PER_DAY) {
    throw new CzrhdError('throttled', `今日现签已达上限 ${MINT_MAX_PER_DAY} 次，本轮跳过`);
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
    throw new CzrhdError('credential', `现签失败 retCode=${retCode}(${retDesc})`);
  }

  const setCookie = (res.setCookies || []).find((x) => /JSESSIONID=/.test(x)) || '';
  const token = buildAppToken(setCookie);
  if (!token) {
    throw new CzrhdError('credential', `现签没拿到 JSESSIONID（HTTP ${res.status}${retCode ? `, retCode=${retCode}` : ''}）`);
  }
  const ticket = (/(?:^|;\s*)ticketID=([^;]+)/.exec(setCookie) || [])[1] || '?';
  log(`✅ 现签网关会话成功（ticketID=${ticket}，今日第 ${ms.count} 次）`);
  return token;
}

/* ------------------------------------------------------------------ */
/* 换票（与 qwhd 同构，只是 cookie 名不同）                              */
/* ------------------------------------------------------------------ */

async function mintSessionToken(account, cfg, appTokenOverride) {
  const actUrl = activityUrl(account, cfg);
  const loginUrl = `${BASE}/qwhdsso/login?dlwmh=true&actUrl=${encodeURIComponent(actUrl)}`;

  // 1. 登录页里取 sid
  const page = await httpFetch(loginUrl, {
    method: 'GET',
    timeoutMs: cfg.timeoutMs,
    headers: baseHeaders({ cookie: `qwhd_center_router=ly; yx=${account.yx}` }),
  });
  const sidMatch = /QWHDSSOD[0-9A-Za-z]+/.exec(page.text);
  if (!sidMatch) {
    throw new CzrhdError('credential', `/qwhdsso/login 没拿到 sid（HTTP ${page.status}）`);
  }
  const sid = sidMatch[0];

  // 2. 重放 blob 换票
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
    headers: baseHeaders({ referer: loginUrl, cookie: `qwhd_center_router=ly; yx=${account.yx}` }),
    body: JSON.stringify(body),
  });
  const loginJson = parseJson(login.text, 'appTokenLogin');
  if (loginJson.code !== 'SUCCESS') {
    // 服务端原文只进面板日志；通知里用自有文案
    throw new CzrhdError('credential', `换票被拒(${str(loginJson.msg, '未知原因')})`, { code: loginJson.code });
  }

  // 3. 回跳页面拿 session cookie
  const back = await httpFetch(`${actUrl}&token=${encodeURIComponent(sid)}`, {
    method: 'GET',
    timeoutMs: cfg.timeoutMs,
    headers: baseHeaders({ cookie: `qwhd_center_router=ly; yx=${account.yx}` }),
  });
  const sessionToken = findCookie(back.headers, SESSION_COOKIE);
  if (!sessionToken) {
    throw new CzrhdError('credential', `换票回调没有下发 ${SESSION_COOKIE}（HTTP ${back.status}）`);
  }
  log(`✅ 换票成功 yx=${account.yx} token=${maskSecret(sessionToken)}`);
  return { sessionToken, actUrl };
}

/* ------------------------------------------------------------------ */
/* 业务请求                                                            */
/* ------------------------------------------------------------------ */

async function apiPost(account, cfg, ctx, apiPath, bodyObj = {}) {
  const res = await httpFetch(`${API_PREFIX}/${apiPath}`, {
    method: 'POST',
    timeoutMs: cfg.timeoutMs,
    headers: baseHeaders({
      'login-check': '1',
      referer: ctx.actUrl,
      cookie: `qwhd_center_router=ly; ${SESSION_COOKIE}=${ctx.sessionToken}; yx=${account.yx}`,
    }),
    body: JSON.stringify(bodyObj),
  });
  const json = parseJson(res.text, apiPath);
  // 失败回 HTTP 200、错误只在 body：判活只看业务码
  if (json.code === 'GOTO_LOGIN' || json.status === 'GOTO_LOGIN') {
    throw new CzrhdError('credential', `${apiPath} 需要重新登录`, { httpStatus: res.status });
  }
  return json;
}

/* ------------------------------------------------------------------ */
/* 抽奖                                                                */
/* ------------------------------------------------------------------ */

function describePrize(prize) {
  if (!prize || typeof prize !== 'object') return null;
  const name = str(prize.name, '未知奖品');
  const short = str(prize.shortName);
  const threshold = str(prize.subTitle);
  const expire = str(prize.countdown) || (prize.expire ? `${prize.expire}天` : '');
  const title = short && !name.includes(short) ? `${name}（${short}）` : name;
  const bits = [title];
  if (threshold) bits.push(threshold);
  if (expire) bits.push(`有效期 ${expire}`);
  return bits.join('｜');
}

// 从各种响应形状里挖出奖品（drawPrize / queryDrawPrizeInfo 的 data 结构不统一）
function pickPrize(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.getPrize && typeof data.getPrize === 'object') return data.getPrize;
  if (Array.isArray(data.actPrize) && data.actPrize.length) return data.actPrize[0];
  return null;
}

async function drawOnce(account, cfg, ctx) {
  const before = await apiPost(account, cfg, ctx, 'queryDrawPrizeInfo');
  if (before.code !== CODE_OK) {
    return { kind: 'error', status: before.code, detail: `queryDrawPrizeInfo code=${str(before.code, '空')} ${str(before.msg)}` };
  }
  const rdStatus = num(before.data && before.data.rdStatus, -1);
  const label = RD_STATUS[rdStatus] || `未知状态 ${rdStatus}`;
  log(`抽奖状态 rdStatus=${rdStatus}（${label}）`);

  // 只有 1(start) 确定可以开抢；3/4/5(已中奖/发放中/已用) 也要探一次 ——
  // 「场次重置后 rdStatus 会不会回到 1」未实测（2026-11-25 只验证了 10:12 那场），
  // 而 160003「已参与过秒杀活动」是服务端对本场次的权威回答，重复探测零副作用（实测不消耗奖品）。
  const canDraw = rdStatus === 1;
  const maybeNewRound = rdStatus === 3 || rdStatus === 4 || rdStatus === 5;
  if (canDraw || maybeNewRound) {
    if (!cfg.write) {
      return { kind: 'readonly', status: rdStatus, detail: `只读模式：状态=${label}，未发 drawPrize` };
    }
    const res = await apiPost(account, cfg, ctx, 'drawPrize', {});
    log(`drawPrize → code=${str(res.code, '空')} msg=${str(res.msg)}`);

    if (res.code === CODE_OK) {
      const prize = pickPrize(res.data);
      return { kind: 'won', status: rdStatus, prize, detail: describePrize(prize) || '抽奖成功（响应里没有奖品字段）' };
    }
    if (res.code === CODE_ALREADY_JOINED) {
      const prize = pickPrize(before.data);
      return {
        kind: 'already',
        status: rdStatus,
        detail: `本场次已参与（160003）${describePrize(prize) ? `，持有：${describePrize(prize)}` : ''}`,
      };
    }
    // 没到点之类：状态是 1/7 说明还在抢券窗口内，值得短间隔重试（分批放券/开闸误差）；
    // 其余码直接报出来
    return {
      kind: 'error',
      status: res.code,
      detail: `drawPrize code=${str(res.code, '空')} ${noticeSafe(str(res.msg))}`,
      retryable: rdStatus === 1 || rdStatus === 7,
    };
  }

  if (rdStatus === 2) return { kind: 'nochance', status: rdStatus, detail: '无抽奖次数（打卡/浏览任务可加次数）' };
  if (rdStatus === 6) return { kind: 'closed', status: rdStatus, detail: '非活动日（noWeek）' };
  if (rdStatus === 0) return { kind: 'closed', status: rdStatus, detail: '砍价/bargain 状态，非抽奖阶段' };
  if (rdStatus === 10) return { kind: 'closed', status: rdStatus, detail: '抽奖被锁定（locked）' };

  return { kind: 'error', status: rdStatus, detail: `无法识别的 rdStatus=${rdStatus}（前端契约可能已变，先别当成失败重试）` };
}

async function collectUnusedPrizes(account, cfg, ctx) {
  try {
    const res = await apiPost(account, cfg, ctx, 'getPrizeList');
    if (res.code !== CODE_OK || !res.data || !Array.isArray(res.data.prizeList)) return [];
    return res.data.prizeList
      .filter((p) => p && ['UNUSED', 'TOSEND'].includes(str(p.sendStatus)) && num(p.expire, 1) !== 0)
      .map((p) => describePrize(p))
      .filter(Boolean);
  } catch (e) {
    logWarn(`⚠️ 拉取「我的奖品」失败（不影响抽奖结论）: ${e.message}`);
    return [];
  }
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
  for (const root of [path.dirname(__dirname), process.cwd()].slice(0, 2)) {
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
  for (const file of buildCandidates()) {
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
  if (process.env.CZRHD_PUSH === '0') {
    log('（CZRHD_PUSH=0，未发送通知）');
    return false;
  }
  const fn = loadSendNotify();
  if (fn) {
    try {
      await Promise.resolve(fn(title, content));
      return true;
    } catch (e) {
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
  log(`—— ${tag} 开始（${hhmmShanghai()}，${cfg.write ? '写入模式' : '只读模式'}）`);
  const reporter = { tag, yx: account.yx, kind: null, lines: [], prizes: [], invalid: false, failed: false };

  // 活动只在周三 8:00（新疆/西藏 10:00）开闸，非周三发写请求纯属白消耗：默认只查不发
  const today = nowShanghai().getUTCDay();
  const isWednesday = today === 3;
  const write = cfg.write && (isWednesday || cfg.force);
  if (cfg.write && !write) {
    log('ℹ️ 今天不是周三（且未设 CZRHD_FORCE=1），本次只查状态不抢券');
  }

  let ctx;
  try {
    // 有 autoLogin 模板就现签一张新会话（免人工）；否则退回静态 blob
    let appToken = account.ssoToken;
    if (account.mint && account.mint.xk) {
      appToken = await mintAppSession(account, cfg, cfg.state);
      saveState(cfg.stateFile, cfg.state);
    }
    ctx = await mintSessionToken(account, cfg, appToken);
  } catch (e) {
    if (e instanceof CzrhdError && e.type === 'throttled') {
      // 限频跳过是**正常**的（手滑多跑一次/同一天多账号），不是凭证问题，不能触发人工分流
      log(`ℹ️ ${e.message}`);
      reporter.kind = 'skipped';
      reporter.lines.push(`ℹ️ 本次跳过：${noticeSafe(e.message)}`);
      return reporter;
    }
    if (e instanceof CzrhdError && e.type === 'credential') {
      logErr(`${tag} ❌ 换票失败: ${e.message}`);
      reporter.invalid = true;
      // 凭证类失败必须覆盖「已失效」「重新登录」——下游 Node-RED 靠这两个词分流到人工
      const howto = account.mint && account.mint.xk
        ? 'autoLogin 模板可能已过期：请重新在头像页抓一次 autoLogin 请求体，更新 CZRHD_ACCOUNTS 里的 mint'
        : '请重新登录「中国移动」App 进周三充值日页，重新抓 appTokenLogin 后更新 CZRHD_ACCOUNTS，'
          + '或干脆补上 mint 模板（以后就不用再抓了）';
      reporter.lines.push(`❌ 换票凭证已失效，${howto}`);
      return reporter;
    }
    throw e;
  }

  let result = null;
  for (let attempt = 0; attempt <= cfg.retry; attempt += 1) {
    result = await drawOnce(account, { ...cfg, write }, ctx);
    if (!result.retryable || attempt === cfg.retry) break;
    log(`第 ${attempt + 1} 次未成（${result.detail}），${Math.round(cfg.retryMs / 1000)}s 后重试`);
    await sleep(cfg.retryMs);
  }

  reporter.kind = result.kind;
  const mark = { won: '✅', already: 'ℹ️', nochance: 'ℹ️', closed: 'ℹ️', readonly: 'ℹ️', error: '❌' }[result.kind] || '·';
  // detail 里可能夹着服务端下发的奖品名/门槛文案 → 进通知前收口
  reporter.lines.push(`${mark} ${noticeSafe(result.detail)}`);

  if (result.kind === 'won' || result.kind === 'already') {
    reporter.prizes = await collectUnusedPrizes(account, cfg, ctx);
  }
  if (result.kind === 'error') reporter.failed = true;

  // 状态文件：只记「今天出过券」，供人工复盘；不承担幂等判定（幂等靠服务端 rdStatus/160003）
  cfg.state[account.yx] = {
    at: new Date().toISOString(),
    rdStatus: result.status,
    kind: result.kind,
    detail: redact(result.detail),
  };
  return reporter;
}

/* ------------------------------------------------------------------ */
/* 通知正文                                                            */
/* ------------------------------------------------------------------ */

function buildNotice(reporters, cfg) {
  const lines = [];
  const won = reporters.filter((r) => r.kind === 'won');
  const already = reporters.filter((r) => r.kind === 'already');
  const problems = reporters.filter((r) => r.failed || r.invalid);
  const quiet = reporters.filter((r) => !won.length && !problems.length
    && ['nochance', 'closed', 'already', 'readonly', 'skipped'].includes(r.kind));
  const skipped = reporters.filter((r) => r.kind === 'skipped');

  for (const r of reporters) {
    lines.push(`【${r.tag}】`);
    for (const l of r.lines) lines.push(`  ${l}`);
    if (r.prizes.length) {
      lines.push('  🎟 待使用券:');
      for (const p of r.prizes) lines.push(`    · ${noticeSafe(p)}`);
      lines.push('  👉 请到「中国移动」App 用券充值（本脚本不下单）');
    }
    lines.push('');
  }

  // verdict 最后定稿：标题与正文必须一致，不能「标题成功、正文说已失效」
  let verdict;
  if (problems.length) verdict = '❌ 有账号失败';
  else if (won.length) verdict = '✅ 抢到新券';
  else if (already.length) verdict = 'ℹ️ 本周已参与';
  else if (skipped.length) verdict = 'ℹ️ 限频跳过';
  else if (quiet.length === reporters.length) verdict = 'ℹ️ 只读检查完成';
  else verdict = 'ℹ️ 已完成';

  if (!cfg.write) lines.push('（只读模式 CZRHD_WRITE=0，未发送任何写请求）');
  lines.push(`执行时间: ${hhmmShanghai()}（北京时间）`);
  return { title: `${TASK_TITLE} ${verdict}`, content: lines.join('\n') };
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const cfg = readConfig();
  cfg.state = loadState(cfg.stateFile);
  log(`启动 ${TASK_TITLE}（${hhmmShanghai()}）`);

  if (!cfg.accountsRaw) {
    for (const line of MSG_MISSING.split('\n')) logErr(line);
    logErr('❌ 未配置环境变量 CZRHD_ACCOUNTS，本次跳过');
    process.exitCode = 1;
    return;
  }

  const { accounts, problems } = parseAccounts(cfg.accountsRaw);
  for (const p of problems) logWarn(`⚠️ ${p}`);
  if (!accounts.length) {
    logErr(`❌ CZRHD_ACCOUNTS 里没有可用账号（问题 ${problems.length} 条，见上）`);
    process.exitCode = 1;
    return;
  }
  log(`待处理账号 ${accounts.length} 个`);

  const reporters = [];
  for (let i = 0; i < accounts.length; i += 1) {
    try {
      reporters.push(await runAccount(accounts[i], i, cfg));
    } catch (e) {
      const tag = `账号${i + 1}(yx=${accounts[i].yx})`;
      logErr(`${tag} ❌ 异常: ${e.message}`);
      reporters.push({
        tag, yx: accounts[i].yx, kind: 'error', invalid: /credential/.test(e.type || ''), failed: true,
        lines: [`❌ 发生异常: ${noticeSafe(e.message)}`], prizes: [],
      });
    }
    saveState(cfg.stateFile, cfg.state);
    if (i < accounts.length - 1) await sleep(1200);
  }

  const { title, content } = buildNotice(reporters, cfg);
  log(`\n${title}\n${content}`);
  await notify(title, content);

  if (reporters.some((r) => r.failed || r.invalid)) process.exitCode = 1;
}

main().catch(async (e) => {
  logErr(`❌ 发生异常: ${e && e.message ? e.message : e}`);
  process.exitCode = 1;
  // 顶层兜底也必须发通知，否则「跑挂了」在面板里静默
  try {
    await notify(`${TASK_TITLE} ❌ 发生异常`, `❌ 发生异常: ${noticeSafe(e && e.message ? e.message : e)}\n执行时间: ${hhmmShanghai()}（北京时间）`);
  } catch { /* 通知本身失败就只剩日志 */ }
});
