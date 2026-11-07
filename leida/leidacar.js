#!/usr/bin/env node
/**
 * cron: 27 17 * * *
 * new Env('雷达汽车');
 * description: 雷达汽车 APP 每日签到 + 社区评论（仅支持青龙 Node 环境）
 *
 * 环境变量:
 *   LEIDA_CAR_COOKIE="<rid>#<aid>#<userId>"      单账号
 *   LEIDA_CAR_COOKIE="<rid>#<aid>#<userId>&<rid>#<aid>#<userId>"   多账号用 & 分隔
 *
 * 凭证来源: 雷达汽车 APP 抓包，取请求头里的 rid / aid / userId 三个值，按 # 顺序拼接。
 * 注意: 旧变量名 leidaCarCookie 已停用（站点前缀命名规范），请改名为 LEIDA_CAR_COOKIE。
 *
 * 可选变量:
 *   LEIDA_BASE_URL            站点地址，默认 https://app-api.radar-ev.com
 *   LEIDA_CLIENT_VERSION      请求头 version，默认 41600021（实测不参与鉴权，仅作指纹）
 *   LEIDA_TIMEOUT_MS          单请求超时，默认 20000
 *   LEIDA_COMMENT_COUNT       每日评论条数上限，默认 10（服务端规则上限也是 10；0 = 关闭评论）
 *   LEIDA_COMMENT_GAP_MS      两条评论之间的间隔，默认 12000
 *   LEIDA_COMMENT_SETTLE_MS   发出评论后等待多久再复查，默认 3000
 *   LEIDA_COMMENT_VERIFY      是否复查评论是否落库，默认 true
 *   LEIDA_COMMENT_TEMPLATES   自定义评论文案，用 | 分隔（给了就只用这些，不再组合）
 *   LEIDA_MAX_ESSAY_PAGES     翻文章列表的页数上限，默认 5
 *   LEIDA_STATE_FILE          本地状态文件，默认脚本同目录 .leida_state.json
 *   LEIDA_TZ                  判定「今天」的时区，默认 Asia/Shanghai
 *
 * ── 为什么脚本从「点赞」改成了「签到 + 评论」（2026-11-07） ──────────────────
 *   官方《雷达App积分规则调整公告》自 2026-11-01 起生效：
 *     保留: 每日签到 1 分/天、发帖 20 分/篇(≤5/天)、评论 1 分/条(≤10/天)
 *     取消: 点赞奖励、社区连续浏览奖励、连续签到额外奖励、满额加赠、好友邀请奖励
 *   现网核对: POST /appapi/radarpoints/api/task/manage/list 在
 *     taskType = null/10/20/30/40/50/"" × version = undefined/54/260/261/262/300/"" 的
 *     **全部组合**下都返回 code:200 + taskItems:[] → 任务中心整体下线，点赞已无任何收益，
 *     所以点赞逻辑（activitythumb/thumbs + 进度判定）整段移除。
 *
 * ── 实测接口契约（2026-11-07 单账号真链路） ──────────────────────────────────
 *   GET  /appapi/radarpoints/pointsApp/signIn
 *        成功 code 按成功处理；今日已签到 → code:500001 msg「您已经签到,不能重复签到」。
 *        **必须 GET**：POST 同路径返回 405/405000 HttpRequestMethodNotSupportedException。
 *   POST /appapi/radarpoints/pointsApp/signSquare {signMonth:"YYYY-MM"}
 *        只读日历：data.signInVOList[].signDate(已签日) / data.signDays / data.userPoints(积分余额)。
 *        实测 signMonth 传什么都返回同一个滚动 30 天窗口，故不要依赖它做月份过滤。
 *   GET  /appapi/content/essay/pageCommunity?current=&size=20&channelId=...
 *        code:0，data.records[].essayId
 *   POST /appapi/content/essaycomment/add {essayId,commentDesc,parentId:"",gcType:2}
 *        实测（2026-11-07）：HTTP 200 + code:0 + data{commentId, checkStatus:0, createTime}
 *        → 业务码口径与其他读接口一致（code:0）；但**仍以评论树复查为最终判据**，
 *        因为「受理成功」不等于「发布成功」（可能被审核拦下或随后被清理）。
 *   GET  /appapi/content/api/essay/queryCommentPageTree?essayId=..&current=&size=50
 *        code:0，data.records[] **按 createTime 升序（最新在最后）**＋ data.total；
 *        每项有 commentId / isMine("1"字符串) / checkStatus(0 待审、1 已通过) / commentDesc。
 *
 * ── 成功判据（禁止假成功） ───────────────────────────────────────────────────
 *   签到: 业务码 + 只读日历复核（今日出现在 signInVOList 才算确认）。
 *   「您已经签到」属正常态，不算失败。
 *   评论: 「接口受理」≠「发布成功」。必须在该文评论树里复查到 isMine 且文本一致；
 *        复查不到一律写「待核验」，既不冒充成功也不判失败（审核/风控都会延迟）。
 *        积分只做记账 —— 实测评论积分**延迟到账**，不能拿它当实时判据。
 *
 * ── 为什么需要本地状态文件 ───────────────────────────────────────────────────
 *   任务列表下线后服务端不再提供「今日已评论几条」，重复运行会超发（官方上限 10 条/天）。
 *   因此每条评论成功后**立刻落盘**计数，并在 30 天内按 essayId 去重（实测同批雷同短评会被清理）。
 *   状态文件读不出来/写不进去都只告警，不让脚本失败。
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

const API = {
  signIn: '/appapi/radarpoints/pointsApp/signIn',
  signSquare: '/appapi/radarpoints/pointsApp/signSquare',
  essayPage: '/appapi/content/essay/pageCommunity',
  commentAdd: '/appapi/content/essaycomment/add',
  commentTree: '/appapi/content/api/essay/queryCommentPageTree',
};

// 社区频道 ID（实测取自原脚本，服务端按此下发文章列表）
const ESSAY_CHANNEL_ID = 'PD3455168030976339970';
const ESSAY_PAGE_SIZE = 20;

// 业务成功码：该站点读接口用 0、任务/积分接口用 200，**两套并存**，不要只认一个
const BIZ_OK_CODES = new Set([0, 200]);
// 未登录 / 凭证失效业务码。实测伪造凭证返回 HTTP 200 + code=203「用户未登录!」
const AUTH_FAILED_CODES = new Set([203, 401, 403, -1, 1001]);
// 签到幂等码：今日已签到
const SIGN_ALREADY_CODE = 500001;

// 官方规则：评论每日上限 10 条（硬上限，环境变量只能往小调）
const COMMENT_HARD_LIMIT = 10;
// 评论树分页大小（实测 size=50 可用）
const COMMENT_TREE_SIZE = 50;

const REQUEST_GAP_MS = 300; // 连续写接口之间的最小间隔
const RETRY_MAX = 2; // 仅网络层错误 / 429
const RETRY_BASE_DELAY_MS = 2000;
const RETRY_MAX_DELAY_MS = 15000;
const RETRY_BUDGET_MS = 30000; // 整轮共享等待预算

const REQUEST_TIMEOUT_MS = readIntEnv('LEIDA_TIMEOUT_MS', 20000, 1000, 120000);
const COMMENT_QUOTA = readIntEnv('LEIDA_COMMENT_COUNT', COMMENT_HARD_LIMIT, 0, COMMENT_HARD_LIMIT);
const COMMENT_GAP_MS = readIntEnv('LEIDA_COMMENT_GAP_MS', 12000, 0, 600000);
const COMMENT_SETTLE_MS = readIntEnv('LEIDA_COMMENT_SETTLE_MS', 3000, 0, 120000);
const COMMENT_VERIFY = String(process.env.LEIDA_COMMENT_VERIFY || '').toLowerCase() !== 'false';
const MAX_ESSAY_PAGES = readIntEnv('LEIDA_MAX_ESSAY_PAGES', 5, 1, 100);
const TZ = process.env.LEIDA_TZ || 'Asia/Shanghai';
const STATE_FILE = process.env.LEIDA_STATE_FILE || path.join(__dirname, '.leida_state.json');
// 状态保留天数：官方上限按天计，留 30 天足够做 essayId 去重与文案去重
const STATE_KEEP_DAYS = 30;

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

// ─────────────────────── 评论文案池（组合式） ───────────────────────
// 实测（2026-11-07 复查 11-02 的历史评论）：1~3 字的泛化短评（「爽」「nb」「好看🤩」）虽然
// 能通过审核，但同一篇文章下同批的雷同短评已被服务端清理。因此这里用「10~30 字 + 组合唯一」
// 的写法，既像真人又不会被当成刷分。
const COMMENT_OPENERS = [
  '这台车的外观设计挺对胃口',
  '看完这篇更了解这台车了',
  '路上见过实车，气场确实足',
  '这个角度拍得挺有感觉',
  '细节部分做得挺用心',
  '关注这台车有一阵子了',
  '内容挺实在，没有过度吹捧',
  '这种实测分享很有参考价值',
  '配色看着挺舒服',
  '空间表现比想象中好',
  '开着这样一台车出去应该挺自在',
  '对这类内容一直比较感兴趣',
  '皮卡做到这个程度不容易',
  '这篇写得挺有条理',
  '整体看下来感觉挺靠谱',
  '这个配置在同级里算厚道',
];
const COMMENT_CLOSERS = [
  '，后面有更新继续关注',
  '，希望多分享点用车感受',
  '，支持一下',
  '，写得挺好',
  '，学到了新东西',
  '，先收藏慢慢看',
  '，期待更多实拍',
  '，看着就想试驾',
  '，挺有说服力',
  '，会继续留意的',
  '，这个价位挺有竞争力',
  '，讲得清楚',
  '，感觉还挺实用',
  '，值得看看',
];

// 自定义文案（可选）：给了就只用这些，不再做组合
const CUSTOM_TEMPLATES = parseCustomTemplates(process.env.LEIDA_COMMENT_TEMPLATES);

// ───────────────────────────── 小工具 ─────────────────────────────

/** 读整数环境变量：非法值回落默认，并夹到 [min,max] */
function readIntEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const num = Number(String(raw).trim());
  if (!Number.isFinite(num)) {
    console.warn(`${LOG_PREFIX} ⚠️ ${name} 不是数字，回落到 ${fallback}`);
    return fallback;
  }
  const value = Math.trunc(num);
  if (value < min || value > max) {
    const clamped = Math.min(Math.max(value, min), max);
    console.warn(`${LOG_PREFIX} ⚠️ ${name}=${value} 超出范围 [${min},${max}]，按 ${clamped} 处理`);
    return clamped;
  }
  return value;
}

/** 自定义评论文案：| 分隔、去空、去重、限长、剔除链接/联系方式形态 */
function parseCustomTemplates(raw) {
  const text = String(raw == null ? '' : raw);
  if (!text.trim()) return [];
  const seen = new Set();
  const list = [];
  for (const piece of text.split('|')) {
    const cleaned = sanitizeCommentText(piece);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    list.push(cleaned);
  }
  return list;
}

/** 去链接 / 手机号 / 微信号 / 二维码文本，并限长（未见服务端限制，取保守值） */
function sanitizeCommentText(input) {
  let text = String(input == null ? '' : input);
  text = text.replace(/https?:\/\/\S+/gi, '').replace(/www\.\S+/gi, '');
  text = text.replace(/\+?\d[\d\s-]{5,}\d/g, '');
  text = text.replace(/(微信|vx|v信|wx|qq)\s*[:：]?\s*[\w-]{4,}/gi, '');
  text = text.replace(/\s+/g, ' ').trim();
  return text.slice(0, 60);
}

/** 今日还能发几条：环境变量是「每日上限」，先夹到官方硬上限，再减去今日已发数 */
function computeQuota(dailyLimit, usedToday, hardLimit = COMMENT_HARD_LIMIT) {
  const limit = Math.min(Math.max(0, toSafeInt(dailyLimit, 0)), Math.max(0, toSafeInt(hardLimit, 0)));
  const used = Math.max(0, toSafeInt(usedToday, 0));
  return Math.max(0, limit - used);
}

/** 业务码是否成功（0 / 200 双口径） */
function isBizOk(code) {
  return BIZ_OK_CODES.has(Number(code));
}

/** 数值收口：只接受真数字，其余回落 fallback（服务端可能把数字写成字符串或 null） */
function toSafeInt(value, fallback = 0) {
  const num = typeof value === 'number' ? value : Number(String(value == null ? '' : value).trim());
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

/** 指定时区的今天（YYYY-MM-DD）。容器 TZ 可能是 UTC，不能用本地时间直接取日期 */
function todayInTz(tz, now = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = fmt.formatToParts(now).reduce((acc, item) => {
      if (item.type !== 'literal') acc[item.type] = item.value;
      return acc;
    }, {});
    if (parts.year && parts.month && parts.day) return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    // 时区非法等：回落到 UTC 日期
  }
  return new Date(now).toISOString().slice(0, 10);
}

/** 日期加减（按 UTC 计算，避免夏令时把日期算错） */
function shiftDate(dateStr, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!match) return String(dateStr || '');
  const [, y, m, d] = match;
  const base = Date.UTC(Number(y), Number(m) - 1, Number(d)) + days * 86400000;
  return new Date(base).toISOString().slice(0, 10);
}

// ───────────────────────── 凭证脱敏与文本收口 ─────────────────────────

/** 当前进程已知的敏感值，用于日志批量抹除（运行期由 registerSecrets 填充） */
const knownSecrets = new Set();

function registerSecrets(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length >= 6) knownSecrets.add(value);
  }
}

/** 抹除已知凭证值；超长凭证额外抹除首尾片段，避免被切片后仍可识别 */
function redactLog(input) {
  let text = typeof input === 'string' ? input : String(input);
  for (const secret of knownSecrets) {
    if (!secret) continue;
    text = text.split(secret).join('[redacted]');
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
const SENSITIVE_KEY_RE = /cookie|token|authorization|csrf|clearance|nonce|rid|aid|userid|ipAddress/i;

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
 * 只用于外部文本（服务端 msg、异常 message）；凭证类自有文案不要过这里。
 */
function noticeSafe(text) {
  const cleaned = redactLog(String(text == null ? '' : text));
  return matchesAlertRouting(cleaned) ? NOTICE_SAFE_PLACEHOLDER : cleaned;
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
  const addFixed = (dir) => fixed.push(path.join(dir, 'sendNotify.js'), path.join(dir, 'notify.js'));

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
 * 签到应答分类：ok / already / failed。
 * 「已签到」是正常态：code 500001 或文案含「已经签到」都算（文案可能变，码更硬）。
 */
function classifySignIn(res) {
  if (!res || typeof res !== 'object') return 'failed';
  const code = Number(res.code);
  const msg = String(res.msg == null ? '' : res.msg);
  if (code === SIGN_ALREADY_CODE || msg.includes('已经签到') || msg.includes('已签到')) return 'already';
  if (isBizOk(code)) return 'ok';
  return 'failed';
}

/** 今日是否已出现在签到日历里（signInVOList[].signDate） */
function isSignedOn(calendar, dateStr) {
  const data = calendar && typeof calendar === 'object' ? calendar : null;
  const list = data && Array.isArray(data.signInVOList) ? data.signInVOList : [];
  return list.some((item) => item && String(item.signDate || '').slice(0, 10) === String(dateStr));
}

/** 读积分余额（signSquare.data.userPoints）；读不到返回 null，不要回落成 0 冒充真值 */
function readUserPoints(calendar) {
  const data = calendar && typeof calendar === 'object' ? calendar : null;
  if (!data) return null;
  const raw = data.userPoints;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const num = Number(raw.trim());
    if (Number.isFinite(num)) return num;
  }
  return null;
}

/**
 * 从一页文章里挑评论目标：过滤非法 essayId、已用过的 id，并保持先后顺序。
 * 不做随机（随机由调用方决定），越界在这里就截断。
 */
function pickCommentTargets(records, excludeIds, quota) {
  const list = Array.isArray(records) ? records : [];
  const exclude = excludeIds instanceof Set ? excludeIds : new Set(Array.isArray(excludeIds) ? excludeIds : []);
  const limit = Math.max(0, toSafeInt(quota));
  const out = [];
  for (const record of list) {
    if (out.length >= limit) break;
    if (!record || typeof record !== 'object') continue;
    const essayId = record.essayId;
    if (typeof essayId !== 'string' || !essayId.trim()) continue;
    const id = essayId.trim();
    if (exclude.has(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/**
 * 生成一条评论文案，保证不与 usedSet 重复。
 * pool 支持两种形态：{ openers, closers }（组合式）或 { custom: [...] }（用户自定义）。
 * 组合池取尽时抛 template_exhausted —— 宁可不发，也不重复发同一句。
 */
function buildCommentText(pool, usedSet, rng = Math.random) {
  const used = usedSet instanceof Set ? usedSet : new Set(Array.isArray(usedSet) ? usedSet : []);
  const source = pool && typeof pool === 'object' ? pool : {};

  if (Array.isArray(source.custom) && source.custom.length) {
    const candidates = source.custom.map(sanitizeCommentText).filter(Boolean);
    const pick = pickUnused(candidates, used, rng);
    if (pick) return pick;
    throw new LeidaError('自定义评论文案已全部用过，请补充 LEIDA_COMMENT_TEMPLATES', 'template_exhausted');
  }

  const openers = Array.isArray(source.openers) ? source.openers : [];
  const closers = Array.isArray(source.closers) ? source.closers : [];
  if (!openers.length || !closers.length) {
    throw new LeidaError('评论文案池为空，请检查 LEIDA_COMMENT_TEMPLATES', 'template_exhausted');
  }

  // 先随机试若干次（省时间），再用确定性扫描保证「还有没用过的组合就一定找得到」
  for (let i = 0; i < 64; i += 1) {
    const text = String(openers[Math.floor(rng() * openers.length)]) + String(closers[Math.floor(rng() * closers.length)]);
    if (!used.has(text)) return text;
  }
  for (const opener of openers) {
    for (const closer of closers) {
      const text = String(opener) + String(closer);
      if (!used.has(text)) return text;
    }
  }
  throw new LeidaError('评论文案组合已用尽，请补充 LEIDA_COMMENT_TEMPLATES', 'template_exhausted');
}

/** 从一个池里挑没用过的项（随机起点 + 环形扫描） */
function pickUnused(candidates, used, rng) {
  if (!candidates.length) return null;
  const start = Math.floor(rng() * candidates.length);
  for (let i = 0; i < candidates.length; i += 1) {
    const text = candidates[(start + i) % candidates.length];
    if (!used.has(text)) return text;
  }
  return null;
}

/**
 * 复查评论是否已落库：评论树里存在 isMine 且文本完全一致的记录。
 * isMine 实测是字符串 "1"，但也兼容 true / 1（服务端形态会变）。
 */
function verifyComment(treeData, text) {
  const target = String(text == null ? '' : text).trim();
  if (!target) return { found: false, checkStatus: null };

  const records = collectComments(treeData);
  for (const item of records) {
    if (!item) continue;
    const mine = item.isMine === true || item.isMine === 1 || String(item.isMine || '') === '1';
    if (!mine) continue;
    if (String(item.commentDesc == null ? '' : item.commentDesc).trim() !== target) continue;
    const status = item.checkStatus === null || item.checkStatus === undefined || item.checkStatus === ''
      ? -1
      : toSafeInt(item.checkStatus, -1);
    return { found: true, checkStatus: status };
  }
  return { found: false, checkStatus: null };
}

/** 递归收集评论节点（含 children 回复），最多 4 层，防脏数据递归过深 */
function collectComments(node, depth = 0, out = []) {
  if (!node || typeof node !== 'object' || depth > 4) return out;
  if (Array.isArray(node)) {
    for (const item of node) collectComments(item, depth + 1, out);
    return out;
  }
  if (node.commentDesc !== undefined || node.isMine !== undefined) out.push(node);
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') collectComments(value, depth + 1, out);
  }
  return out;
}

/** 评论树按时间升序返回，新评论在最后 → 需要翻到最后一页 */
function commentTreePages(total, size = COMMENT_TREE_SIZE) {
  const pageSize = Math.max(1, toSafeInt(size, COMMENT_TREE_SIZE));
  const count = toSafeInt(total, 0);
  if (count <= pageSize) return 1;
  return Math.ceil(count / pageSize);
}

// ─────────────────────────── 本地状态文件 ───────────────────────────

function emptyState() {
  return { version: 1, accounts: {} };
}

/** 解析状态文件内容；损坏时返回 ok:false + 空状态（调用方告警，不中断） */
function parseState(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return { ok: true, state: emptyState(), existed: false };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, state: emptyState(), existed: true, reason: 'JSON 语法错误' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, state: emptyState(), existed: true, reason: '根节点不是对象' };
  }
  const accounts = {};
  const source = parsed.accounts && typeof parsed.accounts === 'object' ? parsed.accounts : {};
  for (const [userId, account] of Object.entries(source)) {
    if (!account || typeof account !== 'object' || Array.isArray(account)) continue;
    // 真实结构是 accounts[userId] = { dates: { 'YYYY-MM-DD': {...} } }
    // 兼容早期直接以日期为键的写法，避免一次结构变动把历史计数全丢掉
    const datesSource = account.dates && typeof account.dates === 'object' ? account.dates : account;
    const cleaned = {};
    for (const [date, entry] of Object.entries(datesSource)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (!entry || typeof entry !== 'object') continue;
      cleaned[date] = {
        comments: Math.max(0, toSafeInt(entry.comments, 0)),
        essayIds: Array.isArray(entry.essayIds) ? entry.essayIds.filter((id) => typeof id === 'string') : [],
        texts: Array.isArray(entry.texts) ? entry.texts.filter((item) => typeof item === 'string') : [],
      };
    }
    accounts[String(userId)] = { dates: cleaned };
  }
  return { ok: true, state: { version: 1, accounts }, existed: true };
}

/** 只保留最近 STATE_KEEP_DAYS 天；空账号直接删掉，避免文件无限膨胀 */
function pruneState(state, todayStr, keepDays = STATE_KEEP_DAYS) {
  const result = emptyState();
  if (!state || typeof state !== 'object' || !state.accounts) return result;
  const cutoff = shiftDate(todayStr, -(Math.max(1, keepDays) - 1));
  for (const [userId, value] of Object.entries(state.accounts)) {
    const dates = value && value.dates && typeof value.dates === 'object' ? value.dates : {};
    const kept = {};
    for (const [date, entry] of Object.entries(dates)) {
      if (date < cutoff) continue;
      kept[date] = entry;
    }
    if (Object.keys(kept).length) result.accounts[String(userId)] = { dates: kept };
  }
  return result;
}

/** 取某账号的状态（不存在时给空壳，调用方直接写） */
function accountState(state, userId) {
  const key = String(userId || '');
  if (!state.accounts[key]) state.accounts[key] = { dates: {} };
  if (!state.accounts[key].dates) state.accounts[key].dates = {};
  return state.accounts[key];
}

/** 今日条目（不存在时给默认值，不写入） */
function todayEntry(state, userId, dateStr) {
  const account = state.accounts[String(userId || '')];
  const dates = account && account.dates ? account.dates : {};
  const entry = dates[dateStr];
  if (!entry) return { comments: 0, essayIds: [], texts: [] };
  return {
    comments: Math.max(0, toSafeInt(entry.comments, 0)),
    essayIds: Array.isArray(entry.essayIds) ? entry.essayIds : [],
    texts: Array.isArray(entry.texts) ? entry.texts : [],
  };
}

/** 记一条已提交的评论（计数 + essayId + 文案），跨日自动切新条目 */
function mergeState(state, userId, dateStr, { essayId, text } = {}) {
  const account = accountState(state, userId);
  if (!account.dates[dateStr]) account.dates[dateStr] = { comments: 0, essayIds: [], texts: [] };
  const entry = account.dates[dateStr];
  entry.comments = Math.max(0, toSafeInt(entry.comments, 0)) + 1;
  if (!Array.isArray(entry.essayIds)) entry.essayIds = [];
  if (!Array.isArray(entry.texts)) entry.texts = [];
  if (essayId && !entry.essayIds.includes(essayId)) entry.essayIds.push(essayId);
  if (text && !entry.texts.includes(text)) entry.texts.push(text);
  return state;
}

/** 最近 N 天用过的 essayId（去重） */
function recentEssayIds(state, userId) {
  const account = state.accounts[String(userId || '')];
  const dates = account && account.dates ? account.dates : {};
  const ids = new Set();
  for (const entry of Object.values(dates)) {
    for (const id of (entry && entry.essayIds) || []) if (typeof id === 'string') ids.add(id);
  }
  return ids;
}

/** 最近 N 天用过的文案（去重） */
function recentTexts(state, userId) {
  const account = state.accounts[String(userId || '')];
  const dates = account && account.dates ? account.dates : {};
  const texts = new Set();
  for (const entry of Object.values(dates)) {
    for (const text of (entry && entry.texts) || []) if (typeof text === 'string') texts.add(text);
  }
  return texts;
}

/** 读状态文件；不存在 → 空状态；损坏/不可读 → 告警 + 空状态 + degraded 标记 */
function loadState(filePath = STATE_FILE) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { state: emptyState(), degraded: false, existed: false };
    console.warn(`${LOG_PREFIX} ⚠️ 读取状态文件失败(${filePath}): ${redactLog(error && error.message)}`);
    return { state: emptyState(), degraded: true, existed: true };
  }
  const parsed = parseState(text);
  if (!parsed.ok) {
    console.warn(`${LOG_PREFIX} ⚠️ 状态文件内容无效(${parsed.reason})，已按空状态继续（跨次运行可能超发）`);
    return { state: parsed.state, degraded: true, existed: true };
  }
  return { state: parsed.state, degraded: false, existed: parsed.existed };
}

/** 原子写状态文件：临时文件 + rename；失败只告警（宁可少记一次，也不让任务失败） */
function saveState(state, filePath = STATE_FILE) {
  const tmp = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, filePath);
    return true;
  } catch (error) {
    console.warn(`${LOG_PREFIX} ⚠️ 写入状态文件失败(${filePath}): ${redactLog(error && error.message)}`);
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 清理失败无所谓
    }
    return false;
  }
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
  // okCode === null：调用方自己判定业务码（评论接口响应体未捕获，靠复查定论）
  if (okCode !== null && okCode !== undefined && Number(code) !== Number(okCode)) return { type: 'task_failed' };
  return { type: 'ok' };
}

function sleep(ms) {
  // 注意: 这里**不能** unref。被 await 的等待是流程的一部分，unref 会让事件循环在没有其它句柄时
  // 提前退出（实测: 写请求发不出去，进程就以 exit 0 静默结束）。
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
   * okCode: 期望的业务成功码（0 / 200）；传 null 表示由调用方自行判定业务码。
   */
  async request({ method, path: apiPath, body, okCode = 0, retryable = true }) {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      let response;
      try {
        response = await this.fetchOnce(method, apiPath, body);
      } catch (error) {
        const message = redactLog((error && error.message) || String(error));
        if (!retryable || attempt > RETRY_MAX) {
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
        // 不回显服务端原始 msg（可能自带 invalid/expired），只打业务码 + 位置
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

  /** 签到：必须 GET（POST 返回 405） */
  signIn() {
    return this.request({ method: 'GET', path: API.signIn, okCode: 0, retryable: true });
  }

  /** 签到日历 + 积分余额（只读） */
  getSignCalendar() {
    const month = todayInTz(TZ).slice(0, 7);
    return this.request({
      method: 'POST',
      path: API.signSquare,
      body: { signMonth: month },
      okCode: 200,
      retryable: true,
    });
  }

  getArticles(page = 1) {
    const query = `?current=${page}&size=${ESSAY_PAGE_SIZE}&channelId=${encodeURIComponent(ESSAY_CHANNEL_ID)}`;
    return this.request({ method: 'GET', path: API.essayPage + query, okCode: 0, retryable: true });
  }

  /**
   * 发评论。**不重试**（重试可能重复发布）。
   * 业务码口径：实测 2026-11-07 返回 code:0 + data{commentId, checkStatus}，与读接口一致。
   * 但受理成功不代表发布成功，成功与否仍以评论树复查为最终判据。
   */
  addComment(essayId, commentDesc) {
    return this.request({
      method: 'POST',
      path: API.commentAdd,
      body: { essayId, commentDesc, parentId: '', gcType: 2 },
      okCode: 0,
      retryable: false,
    });
  }

  /** 评论树（升序）。page 由调用方按 total 计算 */
  getCommentTree(essayId, page = 1) {
    const query = `?essayId=${encodeURIComponent(essayId)}&current=${page}&size=${COMMENT_TREE_SIZE}`;
    return this.request({ method: 'GET', path: API.commentTree + query, okCode: 0, retryable: true });
  }
}

// ─────────────────────────── 账号执行流程 ───────────────────────────

class LeidaAccount {
  constructor(account, options = {}) {
    this.account = account;
    this.label = maskUserId(account.userId);
    this.client = new LeidaClient(account, options);
    this.deps = options.deps || {};
    this.state = options.state || emptyState();
    this.statePath = options.statePath || STATE_FILE;
    this.stateDegraded = Boolean(options.stateDegraded);
    this.authFailed = false;
    this.reporter = {
      tasks: [], // 进度类信息（进普通 Bot）
      errors: [], // 异常类信息（影响退出码）
      verdict: 'ok', // ok / partial / failed —— 所有子步骤跑完后才定稿
      incomplete: false,
      signIn: null,
      comment: null,
      points: { before: null, after: null, delta: null },
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
    // 两个步骤互相隔离：签到失败也照常评论，评论失败也不影响签到结论
    await this.runSignInStep();
    if (!this.authFailed) {
      await this.runCommentStep();
    } else {
      // 凭证已失效：继续跑评论只会刷出一堆同类错误
      this.warn('凭证已失效，跳过评论步骤');
    }
    this.finalizeVerdict();
    return this.reporter;
  }

  /** 读签到日历；失败不算任务失败（外部服务问题），但凭证类要抛出 */
  async safeCalendar(where) {
    try {
      return (await this.client.getSignCalendar()).data;
    } catch (error) {
      if (error instanceof LeidaError && error.type === 'auth_failed') throw error;
      this.warn(`${where}读取签到日历失败（不影响后续步骤）: ${error && error.message}`);
      return null;
    }
  }

  async runSignInStep() {
    const date = todayInTz(TZ);
    const info = { status: 'failed', date, detail: '' };

    let before = null;
    try {
      before = await this.safeCalendar('签到前');
    } catch (error) {
      this.recordError('读取签到日历', error);
    }
    this.reporter.points.before = readUserPoints(before);

    if (before && isSignedOn(before, date)) {
      info.status = 'already';
      info.detail = `今日已签到(${date})`;
      this.log(`✅ 签到: ${info.detail}`);
    } else {
      let response = null;
      try {
        response = await this.client.signIn();
      } catch (error) {
        this.recordError('签到', error);
      }
      if (response) {
        const kind = classifySignIn(response);
        if (kind === 'already') {
          info.status = 'already';
          info.detail = `今日已签到(${date})`;
          this.log(`✅ 签到: ${info.detail}（服务端提示已签到）`);
        } else if (kind === 'ok') {
          info.status = 'ok';
          info.detail = `签到成功(${date})`;
          this.log(`✅ 签到: ${info.detail}`);
        } else {
          // 不回显服务端原文，避免污染分流关键词
          this.recordError(
            '签到',
            new LeidaError(`签到接口返回 code=${response.code}（${noticeSafe(response.msg)}）`, 'task_failed'),
          );
          info.status = 'failed';
          info.detail = `签到失败(code=${response.code})`;
        }
      }
    }

    // 复核：以只读日历里「今日是否已签」为准
    let after = null;
    try {
      after = await this.safeCalendar('签到复核');
    } catch (error) {
      this.recordError('签到复核', error);
    }
    this.reporter.points.after = readUserPoints(after);
    if (this.reporter.points.before !== null && this.reporter.points.after !== null) {
      this.reporter.points.delta = this.reporter.points.after - this.reporter.points.before;
    }

    if (info.status === 'ok') {
      if (after && isSignedOn(after, date)) {
        this.log(`✅ 签到复核通过: 日历已包含 ${date}`);
      } else if (after) {
        info.status = 'unverified';
        info.detail = `签到已提交，日历未确认(${date})`;
        this.warn(`签到返回成功但日历里没有 ${date}，按「待确认」处理`);
      } else {
        info.status = 'unverified';
        info.detail = `签到已提交，日历读取失败无法确认(${date})`;
      }
    }

    this.reporter.signIn = info;
  }

  async runCommentStep() {
    const date = todayInTz(TZ);
    const info = {
      status: 'ok',
      quota: 0,
      usedToday: 0,
      submitted: 0,
      verified: 0,
      pending: 0,
      failed: 0,
      skipped: '',
      items: [],
    };
    this.reporter.comment = info;

    if (COMMENT_QUOTA <= 0) {
      info.status = 'skipped';
      info.skipped = 'LEIDA_COMMENT_COUNT=0，已关闭评论';
      this.log(`ℹ️ ${info.skipped}`);
      return;
    }

    const entry = todayEntry(this.state, this.account.userId, date);
    info.usedToday = entry.comments;
    info.quota = computeQuota(COMMENT_QUOTA, entry.comments);
    if (info.quota <= 0) {
      info.status = 'skipped';
      info.skipped = `今日已达上限(${entry.comments}/${COMMENT_HARD_LIMIT})`;
      this.log(`ℹ️ 评论: ${info.skipped}，跳过`);
      return;
    }
    this.log(
      `📋 评论: 今日已发 ${entry.comments}/${COMMENT_HARD_LIMIT}，本轮计划 ${info.quota} 条` +
        (this.stateDegraded ? '（状态文件不可用，跨次运行可能超发）' : ''),
    );

    // ── 收集目标文章（按状态文件里 30 天内用过的 essayId 去重） ──
    const exclude = recentEssayIds(this.state, this.account.userId);
    const targets = [];
    let pagesFetched = 0;
    for (let page = 1; page <= MAX_ESSAY_PAGES && targets.length < info.quota; page += 1) {
      let articles;
      try {
        articles = await this.client.getArticles(page);
      } catch (error) {
        this.recordError(`读取文章列表第 ${page} 页`, error);
        break;
      }
      pagesFetched = page;
      const records = articles && articles.data && articles.data.records;
      if (!Array.isArray(records)) {
        this.recordError('读取文章列表', new LeidaError('文章列表结构未识别(schema_changed)，请维护', 'schema_changed'));
        break;
      }
      const picked = pickCommentTargets(records, exclude, info.quota - targets.length);
      for (const id of picked) {
        if (!targets.includes(id)) targets.push(id);
      }
      for (const id of picked) exclude.add(id); // 同轮也不重复
    }

    if (!targets.length) {
      info.status = 'incomplete';
      info.skipped = `未找到可评论文章（翻 ${pagesFetched} 页）`;
      this.warn(`评论: ${info.skipped}（不视为成功）`);
      this.reporter.incomplete = true;
      return;
    }
    this.log(`🎯 评论: 翻 ${pagesFetched} 页得到 ${targets.length} 个目标文章`);

    const usedTexts = recentTexts(this.state, this.account.userId);
    const pool = CUSTOM_TEMPLATES.length
      ? { custom: CUSTOM_TEMPLATES }
      : { openers: COMMENT_OPENERS, closers: COMMENT_CLOSERS };
    const rng = this.deps.rng || Math.random;
    const waiter = this.deps.sleep || sleep;

    for (let i = 0; i < targets.length; i += 1) {
      const essayId = targets[i];
      let text;
      try {
        text = buildCommentText(pool, usedTexts, rng);
      } catch (error) {
        this.recordError('生成评论文案', error);
        break;
      }

      let response = null;
      let sendError = null;
      try {
        response = await this.client.addComment(essayId, text);
      } catch (error) {
        sendError = error;
      }
      info.submitted += 1;
      usedTexts.add(text);

      // 计数规则：只要请求可能到达服务端就计数（宁可少发，也不要因失败判定把额度算错而超发）。
      // 但凭证失效肯定是没发出去，不算额度。
      const notSent = sendError instanceof LeidaError && sendError.type === 'auth_failed';
      if (!notSent) {
        mergeState(this.state, this.account.userId, date, { essayId, text });
        if (!saveState(this.state, this.statePath)) this.stateDegraded = true;
      }

      // ── 复查：以评论树里「isMine + 文本一致」为唯一成功判据 ──
      let verified = { found: false, checkStatus: null };
      if (COMMENT_VERIFY) {
        await waiter(COMMENT_SETTLE_MS);
        try {
          const first = await this.client.getCommentTree(essayId, 1);
          const data = (first && first.data) || {};
          verified = verifyComment(data, text);
          if (!verified.found) {
            const pages = commentTreePages(data.total, COMMENT_TREE_SIZE);
            if (pages > 1) {
              const last = await this.client.getCommentTree(essayId, pages);
              verified = verifyComment((last && last.data) || {}, text);
            }
          }
        } catch (error) {
          this.warn(`评论复查失败(${essayId}): ${error && error.message}`);
        }
      }

      const shortId = essayId.length > 10 ? `${essayId.slice(0, 10)}…` : essayId;
      const preview = text.length > 16 ? `${text.slice(0, 16)}…` : text;

      if (verified.found) {
        info.verified += 1;
        const audit = verified.checkStatus === 1 ? '已通过审核' : '待审核';
        this.log(`✅ 评论: ${shortId} 「${preview}」已核验(${audit})`);
        info.items.push({ essayId, text, result: 'verified', checkStatus: verified.checkStatus });
      } else if (sendError) {
        info.failed += 1;
        this.recordError(`评论 ${shortId}`, sendError);
        info.items.push({ essayId, text, result: 'failed' });
        if (sendError instanceof LeidaError && sendError.type === 'auth_failed') break; // 后面不用再试了
      } else {
        info.pending += 1;
        const codeText = response && response.code !== undefined ? ` code=${response.code}` : '';
        this.warn(`评论: ${shortId} 已提交，待核验${codeText}（审核或风控延迟均会如此）`);
        info.items.push({ essayId, text, result: 'pending' });
      }

      if (i < targets.length - 1) await waiter(COMMENT_GAP_MS);
    }

    const parts = [`已核验 ${info.verified}/${info.submitted}`];
    if (info.pending) parts.push(`待核验 ${info.pending}`);
    if (info.failed) parts.push(`失败 ${info.failed}`);
    this.log(`📌 评论结果: ${parts.join('，')}（今日累计 ${todayEntry(this.state, this.account.userId, date).comments}/${COMMENT_HARD_LIMIT}）`);

    if (info.failed > 0) info.status = 'failed';
    else if (info.pending > 0) info.status = 'pending';

    // 积分只做记账：评论积分实测延迟到账，不参与成功判定
    if (this.reporter.points.after === null) {
      try {
        const calendar = await this.safeCalendar('评论后');
        const points = readUserPoints(calendar);
        if (points !== null) {
          this.reporter.points.after = points;
          if (this.reporter.points.before !== null) {
            this.reporter.points.delta = points - this.reporter.points.before;
          }
        }
      } catch (error) {
        this.recordError('读取积分余额', error);
      }
    }
  }

  /** verdict 在所有子步骤跑完后定稿 */
  finalizeVerdict() {
    const { signIn, comment, errors } = this.reporter;
    const signInOk = signIn && (signIn.status === 'ok' || signIn.status === 'already');
    const commentOk = !comment || comment.status === 'ok' || comment.status === 'skipped';

    if (errors.length > 0) {
      // 有硬异常：签到成功或已有核验通过的评论 → partial，否则 failed
      const commentGained = Boolean(comment && comment.verified > 0);
      this.reporter.verdict = signInOk || commentGained ? 'partial' : 'failed';
      return;
    }
    if (!signInOk || !commentOk) {
      this.reporter.verdict = 'partial';
      return;
    }
    this.reporter.verdict = 'ok';
  }

  recordError(where, error) {
    const type = error instanceof LeidaError ? error.type : 'unknown';
    // 凭证已失效后，后续同一个账号的失败都是同一个根因，不重复刷屏
    if (this.authFailed) return;
    const raw = redactLog(error instanceof Error ? error.message : String(error));
    this.log(`❌ ${where} 失败: ${raw}`);
    if (type === 'unavailable') {
      // 外部服务故障：只提示，不进异常清单、不影响退出码
      this.reporter.tasks.push(`${this.label}: ${where} 接口不可用，已跳过`);
      return;
    }
    if (type === 'auth_failed') {
      this.authFailed = true;
      // 凭证类自有文案：由这里生成，不过 noticeSafe（否则会被改成中性占位、进不了失效 Bot）
      this.reporter.errors.push({ type, text: `${this.label} 凭证已失效(请重新登录并更新 ${ENV_NAME})` });
      return;
    }
    const text = `${this.label} ${where}: ${noticeSafe(raw)}`;
    // 同一轮里同一条错误只记一次（如签到前/签到/复核连续三次同因失败）
    if (this.reporter.errors.some((item) => item.text === text)) return;
    this.reporter.errors.push({ type, text });
  }
}

// ─────────────────────────── 汇总与通知 ───────────────────────────

function signInText(signIn) {
  if (!signIn) return '';
  if (signIn.status === 'ok') return `成功(${signIn.date})`;
  if (signIn.status === 'already') return `已签到(${signIn.date})`;
  if (signIn.status === 'unverified') return `已提交待确认(${signIn.date})`;
  return '失败';
}

function commentText(comment) {
  if (!comment) return '';
  if (comment.skipped) return comment.skipped;
  const parts = [`已核验 ${comment.verified}/${comment.submitted}`];
  if (comment.pending) parts.push(`待核验 ${comment.pending}`);
  if (comment.failed) parts.push(`失败 ${comment.failed}`);
  return parts.join('，');
}

function buildSummary(accounts, total, configErrors) {
  const lines = [];
  const okCount = accounts.filter((item) => item.reporter.verdict === 'ok').length;
  const failedCount = accounts.filter((item) => item.reporter.verdict === 'failed').length;

  for (const item of accounts) {
    const { reporter } = item;
    const parts = [];
    if (reporter.signIn) parts.push(`签到 ${signInText(reporter.signIn)}`);
    if (reporter.comment) parts.push(`评论 ${commentText(reporter.comment)}`);
    if (reporter.comment && reporter.comment.submitted !== undefined) {
      const used = reporter.comment.usedToday + reporter.comment.submitted;
      if (reporter.comment.submitted || reporter.comment.skipped) {
        parts.push(`今日 ${used}/${COMMENT_HARD_LIMIT}`);
      }
    }
    const before = reporter.points && reporter.points.before;
    const after = reporter.points && reporter.points.after;
    if (before !== null && before !== undefined && after !== null && after !== undefined) {
      parts.push(`积分 ${before}→${after}`);
    }
    // 不能在有异常或未完成时写「无需操作」——那会与 verdict 自相矛盾
    if (!parts.length) parts.push(reporter.verdict === 'ok' ? '无需操作' : '未完成');

    const mark = reporter.verdict === 'ok' ? '✅' : reporter.verdict === 'partial' ? '⚠️' : '❌';
    lines.push(`${mark} ${item.label}  ${parts.join(' | ')}`);

    if (reporter.comment && Array.isArray(reporter.comment.items)) {
      for (const one of reporter.comment.items) {
        const shortId = String(one.essayId || '').slice(0, 10);
        const preview = String(one.text || '').length > 14 ? `${String(one.text).slice(0, 14)}…` : String(one.text || '');
        if (one.result === 'verified') {
          const audit = one.checkStatus === 1 ? '已通过审核' : '待审核';
          lines.push(`   ✅ 评论 ${shortId}… 「${preview}」已核验(${audit})`);
        } else if (one.result === 'pending') {
          lines.push(`   ⚠️ 评论 ${shortId}… 已提交，待核验(审核中)`);
        } else {
          lines.push(`   ❌ 评论 ${shortId}… 提交失败`);
        }
      }
    }
    for (const task of reporter.tasks) lines.push(`   ${task}`);
    for (const error of reporter.errors) lines.push(`   ${redactLog(error.text)}`);
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

  const statePath = options.statePath || STATE_FILE;
  const today = todayInTz(TZ);
  const loaded = options.state ? { state: options.state, degraded: false } : loadState(statePath);
  const state = pruneState(loaded.state, today);
  if (loaded.degraded) {
    console.warn(`${LOG_PREFIX} ⚠️ 状态文件不可用，评论计数无法跨次延续`);
  }

  const results = [];
  for (const account of parsed.accounts) {
    // 多账号：单个失败不中断其余账号
    const executor = new LeidaAccount(account, {
      deps,
      baseUrl: options.baseUrl,
      state,
      statePath,
      stateDegraded: loaded.degraded,
    });
    try {
      const reporter = await executor.run();
      results.push({ label: executor.label, reporter });
    } catch (error) {
      const text = redactLog(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      const type = error instanceof LeidaError ? error.type : 'unknown';
      console.error(`${LOG_PREFIX} ❌ ${executor.label} 执行异常: ${text}`);
      results.push({
        label: executor.label,
        reporter: {
          tasks: [],
          errors:
            type === 'auth_failed'
              ? [{ type, text: `${executor.label} 凭证已失效(请重新登录并更新 ${ENV_NAME})` }]
              : [{ type, text: `${executor.label} 执行异常` }],
          verdict: 'failed',
          signIn: null,
          comment: null,
          points: { before: null, after: null, delta: null },
        },
      });
    }
  }

  if (!options.state) saveState(state, statePath);

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
  const checkThrows = (name, fn, type) => {
    total += 1;
    try {
      fn();
      failed += 1;
      console.log(`FAIL ${name}（期望抛 ${type}，实际没抛）`);
    } catch (error) {
      const ok = error instanceof LeidaError && error.type === type;
      if (!ok) failed += 1;
      console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `（期望 ${type}，实际 ${error && error.type}）`}`);
    }
  };

  // 真桩: 自检期间任何网络调用都算失败（不是只看 fetch 是否存在）
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => {
    networkCalls += 1;
    throw new Error('selfcheck 不应发起网络请求');
  };

  // 1. 分流正向：凭证类失败 / 顶层兜底必须命中
  check(
    '分流:凭证失败命中',
    matchesAlertRouting(`账号***8949 凭证已失效(请重新登录并更新 ${ENV_NAME})`),
    true,
  );
  check('分流:顶层兜底命中', matchesAlertRouting('❌ 发生异常:执行失败'), true);
  check('分流:成功文案不命中', matchesAlertRouting('✅ 签到成功(2026-11-07)'), false);
  check('分流:已签到不命中', matchesAlertRouting('✅ 今日已签到(2026-11-07)'), false);
  check('分流:评论待核验不命中', matchesAlertRouting('⚠️ 评论已提交，待核验(审核中)'), false);

  // 2. 业务码口径
  check('业务码:0 成功', isBizOk(0), true);
  check('业务码:200 成功', isBizOk(200), true);
  check('业务码:203 失败', isBizOk(203), false);
  check('业务码:500001 失败', isBizOk(500001), false);
  check('业务码:字符串 200 成功', isBizOk('200'), true);

  // 3. 签到分类
  check('签到:500001 视为已签', classifySignIn({ code: 500001, msg: '' }), 'already');
  check('签到:文案带已经签到', classifySignIn({ code: 1, msg: '您已经签到,不能重复签到' }), 'already');
  check('签到:成功码 0', classifySignIn({ code: 0, msg: '成功！' }), 'ok');
  check('签到:成功码 200', classifySignIn({ code: 200, msg: '成功！' }), 'ok');
  check('签到:业务失败', classifySignIn({ code: 500, msg: '系统繁忙' }), 'failed');
  check('签到:空响应失败', classifySignIn(null), 'failed');

  // 4. 签到日历与积分
  const calendar = {
    signInVOList: [{ signDate: '2026-11-06' }, { signDate: '2026-11-07' }],
    signDays: 2,
    userPoints: 309,
  };
  check('日历:命中今日', isSignedOn(calendar, '2026-11-07'), true);
  check('日历:未命中', isSignedOn(calendar, '2026-11-05'), false);
  check('日历:空列表', isSignedOn({ signInVOList: [] }, '2026-11-07'), false);
  check('日历:畸形输入不崩', isSignedOn(null, '2026-11-07'), false);
  check('积分:数字', readUserPoints(calendar), 309);
  check('积分:字符串数字', readUserPoints({ userPoints: '309' }), 309);
  check('积分:非法回落 null', readUserPoints({ userPoints: 'x' }), null);
  check('积分:缺失回落 null', readUserPoints(null), null);

  // 5. 时区与日期
  check('时区:上海跨日', todayInTz('Asia/Shanghai', new Date('2026-11-06T20:00:00Z')), '2026-11-07');
  check('时区:UTC 同日', todayInTz('UTC', new Date('2026-11-06T20:00:00Z')), '2026-11-06');
  check('日期:减一天', shiftDate('2026-11-01', -1), '2026-10-31');
  check('日期:畸形原样', shiftDate('x', -1), 'x');

  // 6. 评论目标筛选
  const records = [
    { essayId: 'A1' },
    { essayId: 'A2' },
    { essayId: '' },
    { essayId: 'A1' },
    { essayId: 'A3' },
  ];
  check('目标:按排除集过滤并截断', pickCommentTargets(records, new Set(['A2']), 2), ['A1', 'A3']);
  check('目标:非数组不崩', pickCommentTargets(null, new Set(), 3), []);
  check('目标:定额为 0', pickCommentTargets(records, new Set(), 0), []);

  // 6b. 今日剩余额度（回归：配额算错会直接导致超发）
  check('配额:首轮跑满', computeQuota(10, 0), 10);
  check('配额:已满为 0', computeQuota(10, 10), 0);
  check('配额:超发回落 0', computeQuota(10, 12), 0);
  check('配额:按今日已发扣减', computeQuota(3, 1), 2);
  check('配额:环境值大于硬上限时夹住', computeQuota(99, 0), 10);
  check('配额:关闭评论', computeQuota(0, 0), 0);
  check('配额:非法值回落 0', computeQuota('x', 0), 0);

  // 7. 评论文案
  const pool = { openers: ['甲甲甲甲甲甲', '乙乙乙乙乙乙'], closers: ['，子子子子', '，丑丑丑丑'] };
  const used = new Set();
  const texts = [];
  let seed = 7;
  const rng = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 4; i += 1) {
    const text = buildCommentText(pool, used, rng);
    used.add(text);
    texts.push(text);
  }
  check('文案:四条互不相同', new Set(texts).size, 4);
  checkThrows('文案:组合用尽抛错', () => buildCommentText(pool, used, rng), 'template_exhausted');
  check('文案:自定义池优先', buildCommentText({ custom: ['自定义一句'], openers: ['x'], closers: ['y'] }, new Set(), () => 0), '自定义一句');
  checkThrows('文案:自定义池用尽抛错', () => buildCommentText({ custom: ['同一句'] }, new Set(['同一句']), () => 0), 'template_exhausted');
  check('文案:默认池长度达标', `${COMMENT_OPENERS[0]}${COMMENT_CLOSERS[0]}`.length >= 10, true);
  check('文案:剔除链接', sanitizeCommentText('不错 https://x.com 支持'), '不错 支持');

  // 8. 评论复查（升序 + 分页 + isMine 形态）
  const tree = {
    total: 60,
    records: [
      { commentDesc: '别人的', isMine: '0', checkStatus: 1 },
      { commentDesc: '我的这句', isMine: '1', checkStatus: 0 },
    ],
  };
  check('复查:命中且带审核态', verifyComment(tree, '我的这句'), { found: true, checkStatus: 0 });
  check('复查:isMine 为 true 也认', verifyComment({ records: [{ commentDesc: 'X', isMine: true, checkStatus: 1 }] }, 'X'), {
    found: true,
    checkStatus: 1,
  });
  check('复查:文本不等不算', verifyComment({ records: [{ commentDesc: 'Y', isMine: '1' }] }, 'X'), {
    found: false,
    checkStatus: null,
  });
  check('复查:别人的不算', verifyComment({ records: [{ commentDesc: 'X', isMine: '0' }] }, 'X'), {
    found: false,
    checkStatus: null,
  });
  check('复查:空数据不崩', verifyComment(null, 'X'), { found: false, checkStatus: null });
  check('复查:子回复也能找到', verifyComment({ records: [{ commentDesc: '父', children: [{ commentDesc: '子', isMine: '1' }] }] }, '子'), {
    found: true,
    checkStatus: -1,
  });
  check('分页:未超一页', commentTreePages(20, 50), 1);
  check('分页:刚好一页', commentTreePages(50, 50), 1);
  check('分页:超一页取末页', commentTreePages(51, 50), 2);
  check('分页:total 缺失回落 1', commentTreePages(undefined, 50), 1);

  // 9. 状态文件
  check('状态:空文本视为空状态', parseState('').ok, true);
  check('状态:损坏标记 ok=false', parseState('{oops').ok, false);
  check('状态:根不是对象', parseState('[1,2]').ok, false);
  const stateObj = parseState(
    JSON.stringify({
      version: 1,
      accounts: {
        1234: {
          dates: {
            '2026-11-07': { comments: 2, essayIds: ['WZ1'], texts: ['文案'] },
            'bad-date': { comments: 1 },
          },
        },
      },
    }),
  ).state;
  check('状态:丢弃非法日期', Object.keys(stateObj.accounts['1234'].dates), ['2026-11-07']);
  check('状态:保留计数', todayEntry(stateObj, '1234', '2026-11-07').comments, 2);

  // 回归：真实结构必须能过一遍 JSON 往返（曾因漏一层 .dates 把历史计数全丢掉）
  const roundTripState = parseState(
    JSON.stringify(mergeState(emptyState(), '1234', '2026-11-07', { essayId: 'WZ9', text: '往返文案' })),
  ).state;
  check('状态:JSON 往返保留计数', todayEntry(roundTripState, '1234', '2026-11-07').comments, 1);
  check('状态:JSON 往返保留 essayId', [...recentEssayIds(roundTripState, '1234')], ['WZ9']);
  check('状态:JSON 往返保留文案', [...recentTexts(roundTripState, '1234')], ['往返文案']);

  const merged = mergeState(emptyState(), '1234', '2026-11-07', { essayId: 'WZ1', text: '文案' });
  mergeState(merged, '1234', '2026-11-07', { essayId: 'WZ2', text: '文案2' });
  check('状态:同日累加', todayEntry(merged, '1234', '2026-11-07').comments, 2);
  check('状态:记录 essayId', [...recentEssayIds(merged, '1234')], ['WZ1', 'WZ2']);
  check('状态:记录文案', [...recentTexts(merged, '1234')], ['文案', '文案2']);
  const pruned = pruneState(
    {
      version: 1,
      accounts: {
        1234: {
          dates: {
            '2026-11-07': { comments: 1, essayIds: [], texts: [] },
            '2026-09-01': { comments: 5, essayIds: ['OLD'], texts: [] },
          },
        },
        5678: { dates: { '2026-09-01': { comments: 1, essayIds: [], texts: [] } } },
      },
    },
    '2026-11-07',
  );
  check('状态:30 天外被裁剪', Object.keys(pruned.accounts['1234'].dates), ['2026-11-07']);
  check('状态:空账号被移除', Object.keys(pruned.accounts), ['1234']);

  // 10. 汇总自洽
  const okAccount = {
    label: '账号***8949',
    reporter: {
      verdict: 'ok',
      tasks: [],
      errors: [],
      signIn: { status: 'already', date: '2026-11-07' },
      comment: { submitted: 3, verified: 3, pending: 0, failed: 0, usedToday: 0, skipped: '', items: [] },
      points: { before: 309, after: 309, delta: 0 },
    },
  };
  const okNotice = buildSummary([okAccount], 1, []);
  check('汇总:成功不命中分流', matchesAlertRouting(`${okNotice.title}\n${okNotice.content}`), false);
  check('汇总:成功计数', okNotice.okCount, 1);
  check('汇总:今日累计显示', okNotice.content.includes('今日 3/10'), true);

  const pendingAccount = {
    label: '账号***8949',
    reporter: {
      verdict: 'partial',
      tasks: [],
      errors: [],
      signIn: { status: 'ok', date: '2026-11-07' },
      comment: {
        submitted: 2,
        verified: 0,
        pending: 2,
        failed: 0,
        usedToday: 0,
        skipped: '',
        items: [{ essayId: 'WZ3855145511', text: '这台车的外观挺对胃口，支持一下', result: 'pending' }],
      },
      points: { before: 307, after: 308, delta: 1 },
    },
  };
  const pendingNotice = buildSummary([pendingAccount], 1, []);
  check('汇总:待核验不命中分流', matchesAlertRouting(`${pendingNotice.title}\n${pendingNotice.content}`), false);
  check('汇总:待核验如实标注', pendingNotice.content.includes('待核验'), true);
  check('汇总:待核验不计成功', pendingNotice.okCount, 0);

  const limitAccount = {
    label: '账号***8949',
    reporter: {
      verdict: 'ok',
      tasks: [],
      errors: [],
      signIn: { status: 'already', date: '2026-11-07' },
      comment: { submitted: 0, verified: 0, pending: 0, failed: 0, usedToday: 10, skipped: '今日已达上限(10/10)', items: [] },
      points: { before: 309, after: 309, delta: 0 },
    },
  };
  const limitNotice = buildSummary([limitAccount], 1, []);
  check('汇总:到上限不命中分流', matchesAlertRouting(`${limitNotice.title}\n${limitNotice.content}`), false);
  check('汇总:到上限写清楚', limitNotice.content.includes('已达上限'), true);

  const authAccount = {
    label: '账号***8949',
    reporter: {
      verdict: 'failed',
      tasks: [],
      errors: [{ type: 'auth_failed', text: `账号***8949 凭证已失效(请重新登录并更新 ${ENV_NAME})` }],
      signIn: { status: 'failed', date: '2026-11-07' },
      comment: null,
      points: { before: null, after: null, delta: null },
    },
  };
  const authNotice = buildSummary([authAccount], 1, []);
  check('汇总:凭证失败命中且含重新登录', matchesAlertRouting(`${authNotice.title}\n${authNotice.content}`), true);
  check('汇总:凭证文案含变量名', authNotice.content.includes(ENV_NAME), true);
  check('汇总:失败账号不写无需操作', authNotice.content.includes('无需操作'), false);

  const emptyNotice = buildSummary(
    [
      {
        label: '账号***8949',
        reporter: {
          verdict: 'partial',
          incomplete: true,
          tasks: ['账号***8949: 未找到可评论文章（翻 5 页）'],
          errors: [],
          signIn: { status: 'already', date: '2026-11-07' },
          comment: { submitted: 0, verified: 0, pending: 0, failed: 0, usedToday: 0, skipped: '未找到可评论文章（翻 5 页）', items: [] },
          points: { before: 309, after: 309, delta: 0 },
        },
      },
    ],
    1,
    [],
  );
  check('汇总:无目标不写无需操作', emptyNotice.content.includes('无需操作'), false);

  // 11. 脱敏
  registerSecrets(['SECRET-VALUE-123456']);
  check('脱敏:已知凭证被抹除', redactLog('header rid=SECRET-VALUE-123456 结束'), 'header rid=[redacted] 结束');
  check('脱敏:账号只留末四位', maskUserId('323034393083949'), '账号***3949');
  check('脱敏:响应敏感字段被抹', scrubResponse({ userid: 'x', nested: { token: 'y' } }).nested.token, '[redacted]');

  // 12. 收口
  check('收口:命中关键词换占位', noticeSafe('服务端说 invalid token'), NOTICE_SAFE_PLACEHOLDER);
  check('收口:普通文案原样', noticeSafe('业务码非成功 code=500'), '业务码非成功 code=500');

  // 13. 自检本身不发网络请求（上面装了计数桩）
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
  isBizOk,
  todayInTz,
  shiftDate,
  classifyResponse,
  classifySignIn,
  isSignedOn,
  readUserPoints,
  pickCommentTargets,
  buildCommentText,
  sanitizeCommentText,
  computeQuota,
  verifyComment,
  collectComments,
  commentTreePages,
  parseAccounts,
  emptyState,
  parseState,
  pruneState,
  accountState,
  todayEntry,
  mergeState,
  recentEssayIds,
  recentTexts,
  loadState,
  saveState,
  buildSummary,
  renderNotification,
  run,
  runSelfCheck,
  LOG_PREFIX,
  TASK_TITLE,
  ENV_NAME,
  NOTICE_SAFE_PLACEHOLDER,
  COMMENT_HARD_LIMIT,
  COMMENT_OPENERS,
  COMMENT_CLOSERS,
};
