#!/usr/bin/env node
/**
 * cron: 27 17 * * *
 * new Env('雷达汽车');
 * description: 雷达汽车 APP 每日任务自动点赞（仅支持青龙 Node 环境）
 *
 * 环境变量:
 *   LEIDA_CAR_COOKIE="<rid>#<aid>#<userId>"      单账号
 *   LEIDA_CAR_COOKIE="<rid>#<aid>#<userId>&<rid>#<aid>#<userId>"   多账号用 & 分隔
 *
 * 凭证来源: 雷达汽车 APP 抓包，取请求头里的 rid / aid / userId 三个值，按 # 顺序拼接。
 * 注意: 旧变量名 leidaCarCookie 已停用（站点前缀命名规范），请改名为 LEIDA_CAR_COOKIE。
 *
 * 可选变量:
 *   LEIDA_BASE_URL          站点地址，默认 https://app-api.radar-ev.com
 *   LEIDA_CLIENT_VERSION    请求头 version，默认 41600021（实测不参与鉴权，仅作指纹）
 *   LEIDA_TIMEOUT_MS        单请求超时，默认 20000
 *   LEIDA_PROGRESS_SETTLE_MS 写接口后等待进度落库，默认 1500
 *
 * ── 两处 version 不是同一个东西（实测 2026-10-22） ───────────────────────────
 *   请求头 version: 54 / 41600021 / 空 三者返回完全一致 → 不参与鉴权，可随意覆盖。
 *   请求体 version: 261 才下发「浏览」任务，54 少一项 → **影响任务下发**，勿随手改。
 *
 * ── 实测接口契约（2026-10-22 单账号真链路） ──────────────────────────────────
 *   POST /appapi/radarpoints/api/task/manage/list {taskType:'20',version:261}
 *        code:200，data.taskItems[] 含 id/taskName/points/finishNum/maxNum/actionType
 *   GET  /appapi/content/essay/pageCommunity?current=1&size=20&channelId=...
 *        code:0，data.records[] 每项有 essayId 与 thumb(bool，服务端返回的点赞态)
 *   POST /appapi/content/activitythumb/thumbs {essayId,status:1,currentThumb:192}
 *        code:0 + data.result:true，实测 thumb false→true、进度 0/10→1/10 → 成功可复核
 *   POST /appapi/radarpoints/api/task/manage/action/submit {businessCode,actionType:1,userId}
 *        code:200 "成功！" 但 data:null 且**进度恒不动** → 写接口空转，无可靠成功判据
 *
 * ── 范围说明 ─────────────────────────────────────────────────────────────────
 *   本脚本**只做「点赞」任务**。分享任务因上述提交接口空转已被移出范围（用户决定）：
 *   检测到「分享」任务时只打中性提示并跳过，不发任何写请求、不算失败。
 *
 * ── 为什么不用 HTTP 200 判成功 ────────────────────────────────────────────────
 *   点赞的成功判据 = 业务码成功 **且** 重拉任务列表后「点赞」的 finishNum 确有增长。
 *   「返回成功但进度未增长」会如实上报（疑似计数口径或风控），不假装完成。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ─────────────────────────────── 常量 ───────────────────────────────

const LOG_PREFIX = '[leida]';
const TASK_TITLE = '雷达汽车';
const ENV_NAME = 'LEIDA_CAR_COOKIE';

const BASE_URL = (process.env.LEIDA_BASE_URL || 'https://app-api.radar-ev.com').replace(/\/+$/, '');

// 请求头 version: 实测不参与鉴权，仅作 UA 指纹，可覆盖
const CLIENT_VERSION = process.env.LEIDA_CLIENT_VERSION || '41600021';
// 请求体 version: 实测 261 才下发「浏览」任务，54 少一项 → 影响任务下发，勿随手改
const TASK_LIST_BODY_VERSION = 261;

const API = {
  taskList: '/appapi/radarpoints/api/task/manage/list',
  essayPage: '/appapi/content/essay/pageCommunity',
  thumb: '/appapi/content/activitythumb/thumbs',
};

// 社区频道 ID（实测取自原脚本，服务端按此下发文章列表）
const ESSAY_CHANNEL_ID = 'PD3455168030976339970';
const ESSAY_PAGE_SIZE = 20;

// 业务码口径：同一站点两种，勿混用
const CODE_READ_OK = 0; // 读接口（文章列表、点赞）成功码
const CODE_TASKLIST_OK = 200; // 任务列表成功码（实测）

// 未登录 / 凭证失效的业务码。**实测 2026-10-22**：伪造 rid/aid/userId 请求任务列表，
// 服务端返回 HTTP 200 + code=203 + msg「用户未登录!」——注意**不是** 401/403，也不是 HTTP 状态码。
// 判凭证失效只认这里的业务码，不靠响应文案猜（文案可能自带 invalid/expired 污染分流）。
const AUTH_FAILED_CODES = new Set([203, 401, 403, -1, 1001]);

const DAILY_TASK_TYPE = '20'; // 10=新手 30/40=限时（实测空数组），本脚本只处理每日任务
const LIKE_TASK_NAME = '点赞';
const SHARE_TASK_NAME = '分享'; // 仅用于「检测到但本脚本不支持」的提示，不参与任何写请求

const MAX_LIKES_PER_RUN = 10; // 与任务 maxNum 取 min，双保险
const LIKE_CURRENT_THUMB = 192; // 实测取值，服务端未校验其语义；失败不影响判据（仍以进度为准）
const REQUEST_GAP_MS = 300; // 写接口之间的最小间隔，避免突发并发
const RETRY_MAX = 2; // 仅网络层错误 / 429
const RETRY_BASE_DELAY_MS = 2000;
const RETRY_MAX_DELAY_MS = 15000;
const RETRY_BUDGET_MS = 30000; // 整轮共享等待预算
const REQUEST_TIMEOUT_MS = Number(process.env.LEIDA_TIMEOUT_MS) || 20000;
const PROGRESS_SETTLE_MS = Number(process.env.LEIDA_PROGRESS_SETTLE_MS) || 1500;

// 分流关键词表（与青龙 Node-RED 侧「双 TG Bot 分流」节点一致，改动需人工同步）
const ALERT_KEYWORDS =
  '已失效,无效用户,失效,cookie失效,ck失效,登录失效,账号失效,账号过期,重新登录,发生异常,invalid,expired';
// 收口占位文案：自身必须不含任何分流关键词
const NOTICE_SAFE_PLACEHOLDER = '步骤失败(详情见面板日志)';

const MSG_CONFIG_MISSING =
  `❌ 未配置环境变量 ${ENV_NAME}\n` +
  `格式：<rid>#<aid>#<userId>（多账号用 & 分隔）\n` +
  `获取方式：\n` +
  `  1. 打开雷达汽车 APP，进入「发现」页随便点开一篇文章\n` +
  `  2. 用抓包工具（如 Stream / Charles）查看任意 app-api.radar-ev.com 请求\n` +
  `  3. 复制请求头里的 rid、aid、userId 三个值\n` +
  `  4. 按 rid#aid#userId 顺序拼接，填入青龙环境变量 ${ENV_NAME}\n`;

// ───────────────────────── 凭证脱敏与文本收口 ─────────────────────────

/** 当前进程已知的敏感值，用于日志批量抹除（运行期由 registerSecrets 填充） */
const knownSecrets = new Set();

function registerSecrets(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length >= 6) knownSecrets.add(value);
  }
}

/** 抹除已知凭证值；超长凭证额外抹除中段，避免被切片后仍可识别 */
function redactLog(input) {
  let text = typeof input === 'string' ? input : String(input);
  for (const secret of knownSecrets) {
    if (!secret) continue;
    text = text.split(secret).join('[redacted]');
    // 长凭证的任意 12 字符窗口也不该出现（防日志被截断后泄漏片段）
    if (secret.length >= 24) {
      const head = secret.slice(0, 8);
      const tail = secret.slice(-8);
      text = text.split(head).join('[redacted]').split(tail).join('[redacted]');
    }
  }
  return text;
}

/** 账号标识：只保留 userId 末 4 位，便于多账号区分而不泄漏 */
function maskUserId(userId) {
  const text = String(userId || '');
  if (!text) return '账号?';
  if (text.length <= 4) return `账号***${text}`;
  return `账号***${text.slice(-4)}`;
}

/** 递归抹除响应对象里的敏感字段（打印服务端对象前必须过） */
const SENSITIVE_KEY_RE = /cookie|token|authorization|csrf|clearance|nonce|rid|aid|userid|thumbsCntDesc/i;

function scrubResponse(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(scrubResponse);
  const clone = {};
  for (const [key, item] of Object.entries(value)) {
    clone[key] = SENSITIVE_KEY_RE.test(key) ? '[redacted]' : scrubResponse(item);
  }
  return clone;
}

/** 与 Node-RED 分流节点等价的匹配：原文小写 + 去空白紧凑串各匹配一次 */
function matchesAlertRouting(text) {
  const lower = String(text == null ? '' : text).toLowerCase();
  const compact = lower.replace(/\s+/g, '');
  return ALERT_KEYWORDS.split(',')
    .map((keyword) => keyword.trim())
    .filter(Boolean)
    .some((keyword) => lower.includes(keyword) || compact.includes(keyword.replace(/\s+/g, '')));
}

/**
 * 外部动态文本收口：命中分流关键词就换成中性占位，原文只进 console 日志。
 * 只用于外部文本（服务端 msg、异常 message、任务名）；凭证类自有文案不要过这里。
 */
function noticeSafe(text) {
  const cleaned = redactLog(String(text == null ? '' : text));
  return matchesAlertRouting(cleaned) ? NOTICE_SAFE_PLACEHOLDER : cleaned;
}

/** 数值收口：只接受真数字，其余回落 fallback（服务端可能把数字写成字符串或 null） */
function toSafeInt(value, fallback = 0) {
  const num = typeof value === 'number' ? value : Number(String(value == null ? '' : value).trim());
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

// ─────────────────────────────── 错误类 ───────────────────────────────

class LeidaError extends Error {
  constructor(message, type) {
    super(message);
    this.name = 'LeidaError';
    this.type = type;
  }
}

// ─────────────────────── 青龙通知模块动态加载 ───────────────────────

let cachedNotify; // undefined=未查找, null=查找失败
let notifyWarned = false;

function isSameFile(file) {
  try {
    return fs.realpathSync(file) === fs.realpathSync(__filename);
  } catch {
    return false;
  }
}

/**
 * 候选路径两遍构建（参照 spec「先固定位置，再子目录展开」）：
 * 第一遍固定位置永不被挤掉；第二遍只对最近两代目录展开，且有独立预算。
 */
function buildNotifyCandidates() {
  const fixed = [];
  const addFixed = (file) => fixed.push(path.join(file, 'sendNotify.js'), path.join(file, 'notify.js'));

  // 第一遍：脚本同目录 → 逐代向上（到根为止）→ cwd → 青龙标准位置
  let dir = __dirname;
  for (let depth = 0; depth < 4; depth += 1) {
    addFixed(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  addFixed(process.cwd());
  addFixed(path.join(process.cwd(), 'function'));
  addFixed('/ql/data/scripts');
  addFixed('/ql/data/scripts/function');
  addFixed('/ql/scripts');
  addFixed('/ql/scripts/function');

  // 第二遍：只对最近两代目录做子目录展开（只取真目录），独立预算
  const MAX_CHILDREN_PER_ROOT = 40;
  const MAX_EXPANDED = 80;
  const expanded = [];
  for (const root of [__dirname, path.dirname(__dirname)]) {
    if (expanded.length >= MAX_EXPANDED) break;
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    let taken = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || taken >= MAX_CHILDREN_PER_ROOT) continue;
      if (expanded.length >= MAX_EXPANDED) break;
      taken += 1;
      const child = path.join(root, entry.name);
      expanded.push(path.join(child, 'sendNotify.js'), path.join(child, 'notify.js'));
    }
  }

  return [...new Set([...fixed, ...expanded])];
}

/** 兼容三种导出形态：函数 / sendNotify / default */
function pickNotifyFunction(mod) {
  if (typeof mod === 'function') return mod;
  if (mod && typeof mod.sendNotify === 'function') return mod.sendNotify;
  if (mod && typeof mod.default === 'function') return mod.default;
  return null;
}

function getNotifyModule() {
  if (cachedNotify !== undefined) return cachedNotify;
  const candidates = buildNotifyCandidates().filter((file) => !isSameFile(file));
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const notify = pickNotifyFunction(require(file));
      if (notify) {
        cachedNotify = { notify, file };
        return cachedNotify;
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} ⚠️ 加载通知模块失败: ${file}（${redactLog(error && error.message)}）`);
    }
  }
  cachedNotify = null;
  if (!notifyWarned) {
    notifyWarned = true;
    console.error(
      `${LOG_PREFIX} ⚠️ 未找到 sendNotify 模块，本次通知已降级为日志（已搜索 ${candidates.length} 个候选路径）\n` +
        `${LOG_PREFIX}    请把 sendNotify.js 放到脚本同目录、上级目录或 /ql/data/scripts 下`,
    );
  }
  return null;
}

/** 发送通知；任何失败都降级为日志，不中断任务、不改退出码 */
async function sendNotification(title, content, deps = {}) {
  const override = deps.sendNotify;
  if (typeof override === 'function') {
    try {
      await Promise.resolve(override(title, content));
      return true;
    } catch (error) {
      console.error(`${LOG_PREFIX} ⚠️ 通知发送失败: ${redactLog(error && error.message)}`);
    }
  } else {
    const loaded = getNotifyModule();
    if (loaded) {
      try {
        await Promise.resolve(loaded.notify(title, content));
        return true;
      } catch (error) {
        console.error(`${LOG_PREFIX} ⚠️ 青龙通知发送失败: ${redactLog(error && error.message)}`);
      }
    }
  }
  console.log(`\n${title}\n${content}`);
  return false;
}

// ─────────────────────────── 纯函数（可导出） ───────────────────────────

/**
 * 解析账号环境变量：& 切账号、# 切段、trim、去空、保序去重。
 * 段数不足只记 error 并指出下标，绝不构造带 undefined 的坏账号。
 */
function parseAccounts(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) throw new LeidaError(MSG_CONFIG_MISSING, 'config_missing');

  const accounts = [];
  const errors = [];
  const seen = new Set();

  text.split('&').forEach((chunk, position) => {
    const segment = chunk.trim();
    if (!segment) return;
    const index = position + 1;
    const parts = segment.split('#').map((part) => part.trim());
    if (parts.length !== 3 || parts.some((part) => !part)) {
      errors.push({
        index,
        reason: `第 ${index} 段缺少 # 分隔的 3 个值（应为 rid#aid#userId，实际 ${parts.length} 段）`,
      });
      return;
    }
    const [rid, aid, userId] = parts;
    const key = `${rid}#${userId}`;
    if (seen.has(key)) return; // 保序去重
    seen.add(key);
    accounts.push({ index, rid, aid, userId });
  });

  if (!accounts.length && !errors.length) throw new LeidaError(MSG_CONFIG_MISSING, 'config_missing');
  return { accounts, errors };
}

/**
 * 归一任务列表：taskItems 非数组 → schema_changed（不能把空当「今天没任务」）。
 */
function normalizeTasks(response) {
  const items = response && response.data && response.data.taskItems;
  if (!Array.isArray(items)) {
    throw new LeidaError('任务列表结构未识别(schema_changed)，请维护', 'schema_changed');
  }
  return items.map((item) => {
    const finishNum = toSafeInt(item && item.finishNum);
    const maxNum = toSafeInt(item && item.maxNum);
    return {
      id: item && item.id,
      name: String((item && item.taskName) || ''),
      finishNum,
      maxNum,
      remain: Math.max(0, maxNum - finishNum),
    };
  });
}

/**
 * 挑选点赞目标：essayId 必须是非空字符串，thumb 必须是严格 false。
 * 用 slice 截断，越界在纯函数层就消除（原脚本 artList[i] 裸取会崩）。
 */
function pickArticles(records, needLikes) {
  const list = Array.isArray(records) ? records : [];
  const eligible = [];
  let skipped = 0;
  for (const record of list) {
    const essayId = record && record.essayId;
    if (typeof essayId !== 'string' || !essayId.trim()) {
      skipped += 1;
      continue;
    }
    if (record.thumb !== false) {
      skipped += 1; // 已点赞 或 thumb 字段异常，都不作为目标
      continue;
    }
    eligible.push(essayId.trim());
  }
  const limit = Math.max(0, Math.min(toSafeInt(needLikes), MAX_LIKES_PER_RUN));
  return { likeTargets: eligible.slice(0, limit), skipped };
}

/**
 * 进度差量：before/after 都是 normalizeTasks 的结果。
 * 任务项缺失 → taskMissing（官方未下发该任务，不是失败）。
 */
function diffProgress(before, after, taskName) {
  const findTask = (list) => (Array.isArray(list) ? list.find((item) => item.name === taskName) : undefined);
  const beforeTask = findTask(before);
  const afterTask = findTask(after);
  if (!afterTask) {
    return { gained: 0, task: null, taskMissing: true, beforeTask };
  }
  const gained = afterTask.finishNum - (beforeTask ? beforeTask.finishNum : 0);
  return { gained, task: afterTask, taskMissing: false, beforeTask };
}

// ─────────────────────────── 请求层 ───────────────────────────

/**
 * 把 (HTTP 状态, 业务码) 归类成错误类型。纯函数，供请求层与自检共用。
 * 实测踩过：伪造凭证时服务端返回 **HTTP 200 + code=203「用户未登录」**，
 * 只认 401/403 会把它错判成 task_failed，导致失效通知进不了失效提醒 Bot。
 */
function classifyResponse(status, code, okCode) {
  if (status === 404 || status >= 500) return { type: 'unavailable' };
  if (status === 401 || status === 403) return { type: 'auth_failed' };
  if (status !== 200) return { type: 'task_failed' };
  if (AUTH_FAILED_CODES.has(Number(code))) return { type: 'auth_failed' };
  if (Number(code) !== Number(okCode)) return { type: 'task_failed' };
  return { type: 'ok' };
}

function sleep(ms) {
  // 注意: 这里**不能** unref。被 await 的等待是流程的一部分，unref 会让事件循环在没有其它句柄时
  // 提前退出（实测: 点赞循环一个请求都没发，进程就以 exit 0 静默结束）。
  // 只有 fetch 的超时定时器可以 unref —— 那时 socket 句柄本身还在撑住事件循环。
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

class LeidaClient {
  constructor(account, options = {}) {
    this.account = account;
    this.baseUrl = options.baseUrl || BASE_URL;
    this.timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS;
    this.deps = options.deps || {};
    this.retryBudgetMs = RETRY_BUDGET_MS;
    this.headers = {
      'user-agent': 'Dart/3.3 (dart:io)',
      system: 'iOS',
      version: CLIENT_VERSION,
      userid: account.userId,
      'accept-encoding': 'gzip',
      rid: account.rid,
      aid: account.aid,
      host: new URL(this.baseUrl).host,
      'login-system': 'iPhone14,3|iOS 27.0|true|',
      'content-type': 'application/json; charset=utf-8',
    };
  }

  log(message) {
    const logger = this.deps.log || console.log;
    logger(`${LOG_PREFIX} ${redactLog(message)}`);
  }

  warn(message) {
    const logger = this.deps.warn || console.warn;
    logger(`${LOG_PREFIX} ⚠️ ${redactLog(message)}`);
  }

  /**
   * 统一请求：超时、业务码判定、重试、日志脱敏都在这里。
   * okCode: 期望的业务成功码（读接口 0 / 任务接口 200）
   */
  async request({ method, path: apiPath, body, okCode, retryable = true }) {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      let response;
      try {
        response = await this.fetchOnce(method, apiPath, body);
      } catch (error) {
        const isNetwork = true;
        const message = redactLog((error && error.message) || String(error));
        if (!retryable || !isNetwork || attempt > RETRY_MAX) {
          throw new LeidaError(`请求失败(${method} ${apiPath})：${message}`, 'network');
        }
        const delayMs = this.nextRetryDelayMs(attempt);
        if (delayMs === null) {
          throw new LeidaError(`请求失败(${method} ${apiPath})：${message}，已用完本轮重试等待预算`, 'network');
        }
        this.warn(`请求失败(${method} ${apiPath})：${message}，${delayMs}ms 后重试(${attempt}/${RETRY_MAX})`);
        await this.wait(delayMs);
        continue;
      }

      const { status, code, msg } = response;
      if (status === 429) {
        if (!retryable || attempt > RETRY_MAX) {
          throw new LeidaError(`请求被限流(${method} ${apiPath}) HTTP 429`, 'task_failed');
        }
        const retryAfterMs = parseRetryAfterMs(response.retryAfter);
        const delayMs = this.nextRetryDelayMs(attempt, retryAfterMs);
        if (delayMs === null) {
          throw new LeidaError(`请求被限流(${method} ${apiPath}) HTTP 429，已用完本轮重试等待预算`, 'task_failed');
        }
        this.warn(`请求被限流 HTTP 429(${method} ${apiPath})，${delayMs}ms 后重试(${attempt}/${RETRY_MAX})`);
        await this.wait(delayMs);
        continue;
      }

      const verdict = classifyResponse(status, code, okCode);
      if (verdict.type === 'unavailable') {
        // 接口下线 / 服务端故障：属外部服务问题，不进异常清单
        throw new LeidaError(`接口不可用(${method} ${apiPath}) HTTP ${status}`, 'unavailable');
      }
      if (verdict.type === 'auth_failed') {
        throw new LeidaError(`凭证未通过校验(${method} ${apiPath}) HTTP ${status} code=${code}`, 'auth_failed');
      }
      if (verdict.type === 'task_failed') {
        // 不回显服务端 msg（可能自带 invalid/expired），只打业务码 + 位置
        throw new LeidaError(
          `业务码非成功(${method} ${apiPath}) code=${code}，期望 ${okCode}（服务端文案：${noticeSafe(msg)}）`,
          'task_failed',
        );
      }
      return response;
    }
  }

  nextRetryDelayMs(attempt, retryAfterMs) {
    const backoffMs = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
    const delayMs = Math.min(Math.max(backoffMs, retryAfterMs || 0), RETRY_MAX_DELAY_MS);
    if (this.retryBudgetMs < delayMs) return null;
    this.retryBudgetMs -= delayMs;
    return delayMs;
  }

  wait(ms) {
    const waiter = this.deps.sleep || sleep;
    return waiter(ms);
  }

  async fetchOnce(method, apiPath, body) {
    if (typeof this.deps.request === 'function') {
      return this.deps.request({ method, url: this.baseUrl + apiPath, headers: this.headers, body });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const init = { method, headers: this.headers, signal: controller.signal };
      if (body !== undefined) init.body = JSON.stringify(body);
      const res = await fetch(this.baseUrl + apiPath, init);
      const text = await res.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      return {
        status: res.status,
        retryAfter: res.headers.get('retry-after'),
        code: parsed ? parsed.code : undefined,
        msg: parsed ? parsed.msg : '',
        data: parsed ? parsed.data : null,
        raw: text,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  getTaskList() {
    return this.request({
      method: 'POST',
      path: API.taskList,
      body: { taskType: DAILY_TASK_TYPE, version: TASK_LIST_BODY_VERSION },
      okCode: CODE_TASKLIST_OK,
    });
  }

  getArticles() {
    const query = `?current=1&size=${ESSAY_PAGE_SIZE}&channelId=${encodeURIComponent(ESSAY_CHANNEL_ID)}`;
    return this.request({ method: 'GET', path: API.essayPage + query, okCode: CODE_READ_OK });
  }

  like(essayId) {
    return this.request({
      method: 'POST',
      path: API.thumb,
      body: { essayId, status: 1, currentThumb: LIKE_CURRENT_THUMB },
      okCode: CODE_READ_OK,
      retryable: false, // 写接口不盲目重试：4xx/5xx 直接判该步失败
    });
  }
}

// ─────────────────────────── 账号执行流程 ───────────────────────────

class LeidaAccount {
  constructor(account, options = {}) {
    this.account = account;
    this.label = maskUserId(account.userId);
    this.client = new LeidaClient(account, options);
    this.deps = options.deps || {};
    this.reporter = {
      tasks: [], // 进度类信息（进普通 Bot）
      errors: [], // 异常类信息（影响退出码）
      verdict: 'ok', // ok / partial / failed —— 所有子步骤跑完后才定稿
      like: null, // { before, after, gained, maxNum }
      shareUnsupported: false,
      points: null,
    };
  }

  log(message) {
    this.client.log(message);
  }

  warn(message) {
    this.client.warn(message);
  }

  async run() {
    this.log(`------ ${this.label} ------`);
    let before;
    try {
      before = normalizeTasks(await this.client.getTaskList());
    } catch (error) {
      this.recordError('读取任务列表', error);
      this.reporter.verdict = 'failed';
      return this.reporter;
    }

    const likeTask = before.find((item) => item.name === LIKE_TASK_NAME);
    const shareTask = before.find((item) => item.name === SHARE_TASK_NAME);
    if (shareTask) {
      // 分享已移出范围：只如实说明，不发写请求、不计失败
      this.reporter.shareUnsupported = true;
      this.log(
        `ℹ️ 检测到「${SHARE_TASK_NAME}」任务(${shareTask.finishNum}/${shareTask.maxNum})，本脚本不支持` +
          `（提交接口实测返回 200 但进度不动），已跳过`,
      );
    }

    if (!likeTask) {
      this.log(`ℹ️ 今日未下发「${LIKE_TASK_NAME}」任务，跳过`);
      return this.reporter;
    }
    this.log(`📋 ${LIKE_TASK_NAME} 进度: ${likeTask.finishNum}/${likeTask.maxNum}（差额 ${likeTask.remain}）`);
    if (likeTask.remain <= 0) {
      this.log(`✅ ${LIKE_TASK_NAME} 今日已完成(无需操作)`);
      return this.reporter;
    }

    await this.runLikeStep(likeTask, before);

    // verdict 在所有子步骤跑完之后才定稿
    if (this.reporter.errors.length > 0) {
      this.reporter.verdict = this.reporter.like && this.reporter.like.gained > 0 ? 'partial' : 'failed';
    } else if (this.reporter.like && this.reporter.like.gained < Math.min(likeTask.remain, MAX_LIKES_PER_RUN)) {
      this.reporter.verdict = 'partial'; // 接口成功但进度未足额增长
    }
    return this.reporter;
  }

  async runLikeStep(likeTask, before) {
    let articles;
    try {
      articles = await this.client.getArticles();
    } catch (error) {
      this.recordError('读取文章列表', error);
      return;
    }

    const records = (articles.data && articles.data.records) || [];
    const { likeTargets, skipped } = pickArticles(records, likeTask.remain);
    if (skipped > 0) {
      this.warn(`文章列表中有 ${skipped} 条不可用作点赞目标（已点赞 / 缺少 essayId / thumb 非布尔）`);
    }
    if (!likeTargets.length) {
      this.warn('未找到可点赞文章，跳过点赞步骤（不视为成功）');
      this.reporter.tasks.push(`${this.label}: 无可点赞文章，未完成`);
      return;
    }
    this.log(`👍 计划点赞 ${likeTargets.length} 篇（差额 ${likeTask.remain}，单轮上限 ${MAX_LIKES_PER_RUN}）`);

    let accepted = 0;
    for (let i = 0; i < likeTargets.length; i += 1) {
      const essayId = likeTargets[i];
      try {
        const res = await this.client.like(essayId);
        if (res.data && res.data.result === true) accepted += 1;
        else this.warn(`点赞接口未返回 result:true（第 ${i + 1}/${likeTargets.length} 篇）`);
      } catch (error) {
        // 单次失败不中断本轮
        this.recordError(`点赞第 ${i + 1}/${likeTargets.length} 篇`, error);
      }
      if (i < likeTargets.length - 1) await this.client.wait(REQUEST_GAP_MS);
    }

    // 复核：以服务端进度变化为唯一判据，不信自己的文案
    const waiter = this.client.deps.sleep || sleep;
    await waiter(PROGRESS_SETTLE_MS);

    let after;
    try {
      after = normalizeTasks(await this.client.getTaskList());
    } catch (error) {
      this.recordError('复核任务进度', error);
      return;
    }

    const diff = diffProgress(before, after, LIKE_TASK_NAME);
    const afterTask = diff.task || likeTask;
    this.reporter.like = {
      before: diff.beforeTask ? diff.beforeTask.finishNum : likeTask.finishNum,
      after: afterTask.finishNum,
      gained: diff.gained,
      maxNum: afterTask.maxNum,
    };

    if (diff.gained > 0) {
      this.log(`✅ ${LIKE_TASK_NAME} +${diff.gained}（${this.reporter.like.before}→${afterTask.finishNum}/${afterTask.maxNum}）`);
      this.reporter.tasks.push(
        `${this.label}: ${LIKE_TASK_NAME} ${this.reporter.like.before}→${afterTask.finishNum}/${afterTask.maxNum}`,
      );
    } else if (accepted > 0) {
      this.warn(
        `${LIKE_TASK_NAME} 返回成功但进度未增长（${likeTask.finishNum}→${afterTask.finishNum}/${afterTask.maxNum}，` +
          `疑似计数口径或风控）`,
      );
      this.reporter.tasks.push(
        `${this.label}: ${LIKE_TASK_NAME} ${likeTask.finishNum}→${afterTask.finishNum}/${afterTask.maxNum}（进度未增长）`,
      );
    } else {
      this.warn(`${LIKE_TASK_NAME} 无任何一次被服务端受理，进度未变化`);
      this.reporter.tasks.push(`${this.label}: ${LIKE_TASK_NAME} 未完成`);
    }
  }

  recordError(where, error) {
    const type = error instanceof LeidaError ? error.type : 'unknown';
    // 只取 message，不带 Error 子类的 name 前缀（"LeidaError: xxx" 进通知没有意义且会干扰阅读）
    const raw = redactLog(error instanceof Error ? error.message : String(error));
    this.log(`❌ ${where} 失败: ${raw}`);
    if (type === 'unavailable') {
      // 外部服务故障：只提示，不进异常清单、不影响退出码
      this.reporter.tasks.push(`${this.label}: ${where} 接口不可用，已跳过`);
      return;
    }
    if (type === 'auth_failed') {
      // 凭证类自有文案：由这里生成，不过 noticeSafe（否则会被改成中性占位、进不了失效 Bot）
      this.reporter.errors.push({ type, text: `${this.label} 凭证已失效(请重新登录并更新 ${ENV_NAME})` });
      return;
    }
    this.reporter.errors.push({ type, text: `${this.label} ${where}: ${noticeSafe(raw)}` });
  }
}

// ─────────────────────────── 汇总与通知 ───────────────────────────

function buildSummary(accounts, total, configErrors) {
  const lines = [];
  const okCount = accounts.filter((item) => item.reporter.verdict === 'ok').length;
  const failedCount = accounts.filter((item) => item.reporter.verdict === 'failed').length;

  for (const item of accounts) {
    const { reporter } = item;
    const parts = [];
    if (reporter.like) {
      parts.push(
        `${LIKE_TASK_NAME} ${reporter.like.before}→${reporter.like.after}/${reporter.like.maxNum}` +
          `(${reporter.like.gained >= 0 ? '+' : ''}${reporter.like.gained})`,
      );
    }
    if (reporter.shareUnsupported) parts.push(`${SHARE_TASK_NAME}任务未支持(已跳过)`);
    // 不能在有异常时写「无需操作」——那会与 verdict=failed 自相矛盾
    if (!parts.length) parts.push(reporter.verdict === 'failed' ? '未完成' : '无需操作');
    const mark = reporter.verdict === 'ok' ? '✅' : reporter.verdict === 'partial' ? '⚠️' : '❌';
    lines.push(`${mark} ${item.label} ${parts.join(' | ')}`);
    for (const task of reporter.tasks) lines.push(`   ${task}`);
    for (const error of reporter.errors) lines.push(`   ${error.text}`);
  }

  if (configErrors && configErrors.length) {
    for (const error of configErrors) lines.push(`❌ ${error.reason}`);
  }

  const header = `成功 ${okCount} / 共 ${total}` + (failedCount ? `（失败 ${failedCount}）` : '');
  const content = [header, '', ...lines].join('\n');
  return { title: TASK_TITLE, content, okCount, failedCount };
}

function buildMinimalSummary(accounts, total, configErrors) {
  const okCount = accounts.filter((item) => item.reporter.verdict === 'ok').length;
  const lines = [`成功 ${okCount} / 共 ${total}`, ''];
  for (const item of accounts) {
    lines.push(`${item.reporter.verdict === 'ok' ? '✅' : '❌'} ${item.label}`);
  }
  if (configErrors && configErrors.length) lines.push(`❌ 配置有 ${configErrors.length} 处问题`);
  return { title: TASK_TITLE, content: lines.join('\n') };
}

/** 通知自洽守卫：命中关键词但没有凭证类失败 → 剔明细 → 仍命中 → 最小化通知 */
function renderNotification(accounts, total, configErrors) {
  const summary = buildSummary(accounts, total, configErrors);
  const hasAuthFailure = accounts.some((item) => item.reporter.errors.some((error) => error.type === 'auth_failed'));
  if (!matchesAlertRouting(`${summary.title}\n${summary.content}`) || hasAuthFailure) {
    return summary;
  }

  const trimmed = {
    title: summary.title,
    content: [summary.content.split('\n')[0], '', ...accounts.map((item) => `${item.label}: ${item.reporter.verdict}`)].join(
      '\n',
    ),
  };
  if (!matchesAlertRouting(`${trimmed.title}\n${trimmed.content}`)) {
    console.error(`${LOG_PREFIX} ❌ 通知已降级(剔明细后仍含未收口文本，请补收口)`);
    return trimmed;
  }
  console.error(`${LOG_PREFIX} ❌ 通知已降级(最小化通知，请补收口)`);
  return buildMinimalSummary(accounts, total, configErrors);
}

// ─────────────────────────── 主流程 ───────────────────────────

async function run(options = {}) {
  const deps = options.deps || {};
  const env = options.env || process.env;
  const raw = env[ENV_NAME];

  let parsed;
  try {
    parsed = parseAccounts(raw);
  } catch (error) {
    if (error instanceof LeidaError && error.type === 'config_missing') {
      console.error(`${LOG_PREFIX} ${error.message}`);
      await sendNotification(TASK_TITLE, error.message, deps);
      return { exitCode: 1, configMissing: true };
    }
    throw error;
  }

  registerSecrets(parsed.accounts.flatMap((account) => [account.rid, account.aid, account.userId]));
  const total = parsed.accounts.length + parsed.errors.length;
  if (parsed.errors.length) {
    for (const error of parsed.errors) console.error(`${LOG_PREFIX} ❌ ${error.reason}`);
    console.error(`${LOG_PREFIX} ❌ 共 ${parsed.errors.length} 段账号格式有误，已跳过这些段`);
  }
  console.log(`${LOG_PREFIX} 共找到 ${total} 个账号（有效 ${parsed.accounts.length}）`);

  const results = [];
  for (const account of parsed.accounts) {
    // 多账号：单个失败不中断其余账号
    const executor = new LeidaAccount(account, { deps, baseUrl: options.baseUrl });
    try {
      const reporter = await executor.run();
      results.push({ label: executor.label, reporter });
    } catch (error) {
      const text = redactLog(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      console.error(`${LOG_PREFIX} ❌ ${executor.label} 执行异常: ${text}`);
      results.push({
        label: executor.label,
        reporter: { tasks: [], errors: [{ type: 'unknown', text: `${executor.label} 执行异常` }], verdict: 'failed' },
      });
    }
  }

  const notification = renderNotification(results, total, parsed.errors);
  await sendNotification(notification.title, notification.content, deps);

  const hasCredentialFailure = results.some((item) =>
    item.reporter.errors.some((error) => error.type === 'auth_failed'),
  );
  const hasScriptFailure = results.some((item) =>
    item.reporter.errors.some((error) => error.type !== 'auth_failed'),
  );
  const exitCode = parsed.errors.length > 0 || hasCredentialFailure || hasScriptFailure ? 1 : 0;
  return { exitCode, results };
}

// ─────────────────────────── 自检（零网络） ───────────────────────────

function runSelfCheck() {
  let failed = 0;
  let total = 0;
  const check = (name, actual, expected) => {
    total += 1;
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`}`);
  };

  // 真桩: 自检期间任何网络调用都算失败（不是只看 fetch 是否存在）
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => {
    networkCalls += 1;
    throw new Error('selfcheck 不应发起网络请求');
  };

  // 1. 分流正向：凭证类失败 / 顶层兜底必须命中
  // 用虚构值，不要拿真实 userId 当测试夹具（会随仓库公开）
  check('分流:凭证失效命中', matchesAlertRouting(`❌ ${maskUserId('123456789012345')} 凭证已失效(请重新登录并更新 ${ENV_NAME})`), true);
  check('分流:顶层兜底命中', matchesAlertRouting(`❌ 发生异常:执行失败\n\n未知错误: boom`), true);
  // 实测回归：伪造凭证返回的是 HTTP 200 + code=203「用户未登录」，必须归 auth_failed
  check('错误分类:203 归 auth_failed', classifyResponse(200, 203, 200).type, 'auth_failed');

  // 2. 分流反向：非凭证类与成功路径必须不命中
  check('分流:配置缺失不命中', matchesAlertRouting(MSG_CONFIG_MISSING), false);
  check('分流:网络超时不命中', matchesAlertRouting('请求失败(POST /x)：The operation was aborted due to timeout'), false);
  check('分流:结构未识别不命中', matchesAlertRouting('任务列表结构未识别(schema_changed)，请维护'), false);
  check('分流:任务级失败不命中', matchesAlertRouting('业务码非成功(POST /x) code=500，期望 0'), false);
  check('分流:分享任务不支持不命中', matchesAlertRouting('ℹ️ 检测到「分享」任务，本脚本不支持（提交接口实测返回 200 但进度不动），已跳过'), false);
  check('分流:进度未增长不命中', matchesAlertRouting('点赞 返回成功但进度未增长（疑似计数口径或风控）'), false);
  check('分流:成功文案不命中', matchesAlertRouting('✅ 点赞 +9（1→10/10）'), false);
  check('分流:占位文案自身不命中', matchesAlertRouting(NOTICE_SAFE_PLACEHOLDER), false);

  // 3. 账号解析
  const two = parseAccounts('a#b#c&d#e#f');
  check('解析:两账号', two.accounts.length, 2);
  check('解析:保序去重', parseAccounts('a#b#c&a#b#c').accounts.length, 1);
  check('解析:缺段报下标', parseAccounts('a#b&d#e#f').errors.map((e) => e.index), [1]);
  check('解析:缺段不构造坏账号', parseAccounts('a#b&d#e#f').accounts.length, 1);
  let configMissing = false;
  try {
    parseAccounts('   ');
  } catch (error) {
    configMissing = error instanceof LeidaError && error.type === 'config_missing';
  }
  check('解析:全空抛配置缺失', configMissing, true);

  // 4. 文章筛选
  const picked = pickArticles(
    [
      { essayId: 'A1', thumb: false },
      { essayId: 'A2', thumb: true },
      { essayId: '', thumb: false },
      { essayId: 'A3', thumb: 'false' },
      { essayId: 'A4', thumb: false },
    ],
    100,
  );
  check('筛选:严格布尔与上限', picked.likeTargets, ['A1', 'A4']);
  check('筛选:空列表不越界', pickArticles([], 5).likeTargets, []);
  check('筛选:非数组不崩', pickArticles(null, 5).likeTargets, []);

  // 5. 任务归一
  let schemaError = false;
  try {
    normalizeTasks({ data: {} });
  } catch (error) {
    schemaError = error instanceof LeidaError && error.type === 'schema_changed';
  }
  check('归一:结构不符抛 schema_changed', schemaError, true);
  check(
    '归一:数值回落 0',
    normalizeTasks({ data: { taskItems: [{ taskName: '点赞', finishNum: 'x', maxNum: null }] } })[0].remain,
    0,
  );

  // 6. 进度差量
  check('差量:任务缺失', diffProgress([], [], LIKE_TASK_NAME).taskMissing, true);
  check(
    '差量:正常增长',
    diffProgress(
      [{ name: '点赞', finishNum: 1, maxNum: 10, remain: 9 }],
      [{ name: '点赞', finishNum: 4, maxNum: 10, remain: 6 }],
      LIKE_TASK_NAME,
    ).gained,
    3,
  );

  // 7. 汇总自洽
  const okAccounts = [
    {
      label: '账号***8949',
      reporter: {
        verdict: 'ok',
        tasks: ['账号***8949: 点赞 1→10/10'],
        errors: [],
        like: { before: 1, after: 10, gained: 9, maxNum: 10 },
        shareUnsupported: false,
      },
    },
  ];
  const okNotice = buildSummary(okAccounts, 1, []);
  check('汇总:成功通知不命中', matchesAlertRouting(`${okNotice.title}\n${okNotice.content}`), false);
  check('汇总:成功计数', okNotice.okCount, 1);

  const authAccounts = [
    {
      label: '账号***8949',
      reporter: {
        verdict: 'failed',
        tasks: [],
        errors: [{ type: 'auth_failed', text: `账号***8949 凭证已失效(请重新登录并更新 ${ENV_NAME})` }],
        like: null,
        shareUnsupported: false,
      },
    },
  ];
  const authNotice = buildSummary(authAccounts, 1, []);
  check('汇总:凭证失败命中且含重新登录', matchesAlertRouting(`${authNotice.title}\n${authNotice.content}`), true);
  check('汇总:凭证文案含变量名', authNotice.content.includes(ENV_NAME), true);
  // 回归：失败账号不得写「无需操作」（否则与 verdict 自相矛盾）
  check('汇总:失败账号不写无需操作', authNotice.content.includes('无需操作'), false);

  // 8. 收口
  check('收口:命中关键词换占位', noticeSafe('服务端说 invalid token'), NOTICE_SAFE_PLACEHOLDER);
  check('收口:普通文案原样', noticeSafe('业务码非成功 code=500'), '业务码非成功 code=500');

  // 9. 自检本身不发网络请求（上面装了计数桩）
  check('自检:零网络调用', networkCalls, 0);
  globalThis.fetch = originalFetch;

  console.log(`${LOG_PREFIX} 自检${failed ? ` 未通过(${failed}/${total})` : ` 全部通过(${total}/${total})`}`);
  process.exitCode = failed ? 1 : 0;
  return { failed, total };
}

// ─────────────────────────── 入口 ───────────────────────────

async function main() {
  if (Array.isArray(process.argv) && process.argv.includes('--selfcheck')) {
    runSelfCheck();
    return;
  }
  try {
    const { exitCode } = await run();
    console.log(`${LOG_PREFIX} 🚩 执行结束!`);
    process.exitCode = exitCode;
  } catch (error) {
    const errorText = redactLog(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    const translated = noticeSafe(errorText);
    console.error(`${LOG_PREFIX} ❌ 执行失败: ${translated}`);
    await sendNotification(TASK_TITLE, `❌ 发生异常:执行失败\n\n${translated}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  LeidaError,
  matchesAlertRouting,
  noticeSafe,
  redactLog,
  maskUserId,
  scrubResponse,
  toSafeInt,
  classifyResponse,
  parseAccounts,
  normalizeTasks,
  pickArticles,
  diffProgress,
  buildSummary,
  renderNotification,
  run,
  runSelfCheck,
  LOG_PREFIX,
  TASK_TITLE,
  ENV_NAME,
  NOTICE_SAFE_PLACEHOLDER,
};
