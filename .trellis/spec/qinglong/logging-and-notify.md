# 日志与通知

> 脚本头声明、日志格式、以及青龙通知模块的加载方式。

---

## 一、脚本头声明(所有脚本强制)

每个脚本**开头**必须声明调度表达式和面板显示名。实测 13 个业务脚本**全部**具备这两项。

### JavaScript

两种注释风格并存(无 `description:` 时用块注释,有则用行注释):

```js
// 块注释风格 —— anyrouter.js:1
#!/usr/bin/env node
/**
 * cron: 5 8 * * *
 * new Env('AnyRouter 签到');
 *
 * 环境变量: ANYROUTER_COOKIE="session=xxx; acw_tc=xxx; acw_sc__v2=xxx"
 */
```

```js
// 行注释风格 —— hyb-cards-draw.js:2
#!/usr/bin/env node
// cron: 30 8 * * *
// new Env('黑与白福利站 50连抽');
// description: 黑与白福利站每日自动 50 连抽,默认只使用免费次数
```

### Python

```python
# -*- coding: utf8 -*-
"""
cron: 30 8 * * *
new Env('福利吧签到');
"""
```

### 约定要点

| 项 | 约定 |
|---|---|
| `cron:` | 位置固定为**紧接 shebang 之后的第一行**。值就是面板里的调度表达式 |
| `new Env('...')` | 面板任务名,用**中文** |
| `description:` | 可选,一行中文说明。写"默认行为"最有价值(如"默认只使用免费次数") |
| 变量清单 | 必需变量的示例值直接写在头部(如 `环境变量: ANYROUTER_COOKIE="session=xxx"`) |
| 请求量大的脚本 | 用 `*/30 * * * *` 之类高频表达式(`hyb-farm.js`),此时必须在头部说明为何高频 |

新增脚本时**复制同类脚本的头部块**再改内容,不要自创格式。

---

## 二、日志格式

### 前缀常量

```js
const TASK_TITLE = 'AnyRouter 自动签到';   // 通知标题 / 结果汇总
const LOG_PREFIX = '[whos-daily]';         // 日志行前缀
```

实测两种命名,都在用:

| 常量 | 用途 | 实例 |
|------|------|------|
| `TASK_TITLE` | 通知标题、结果表标题 | `whos-daily.js:44`、`aokicore-browser.js:21` |
| `LOG_PREFIX` | 行内日志前缀,小写短横线 | `whos-daily.js:43` `[whos-daily]`、`hyb-farm.js:15` `[hybgzs-farm]` |

部分脚本把前缀直接内联为站点中文名,如 `bohe.js` 用 `[up.x666]`、`laomo-browser.js` 用 `[老魔公益站]`。

**新增脚本**:优先定义 `LOG_PREFIX`(小写短横线形式),需要通知标题时再定义 `TASK_TITLE`。

### 行内格式

```js
console.log(`[up.x666] ✅ 会话验证成功: ${username}`);
console.error(`[up.x666] ❌ 错误详情: ${errorMsg}`);
console.warn(`${LOG_PREFIX} WHOS_RATE_SCORE 超出范围 [1,5],回落到 ${defaultValue}`);
```

规范:

- 每条日志带**方括号前缀**,不加前缀的日志无法在面板多任务混流中定位
- 结果态用 emoji:`✅` 成功 / `❌` 失败 / `⚠️` 警告 / `⏳` 等待
- 文案**中文**,冒号用**全角 `:`**(仓库现状;部分新脚本用半角,不强制统一)
- 参数取值问题用 `console.warn` + 回落默认值,**不要抛错中断**(见上方 `WHOS_RATE_SCORE` 示例)

### 禁止打印凭证

**Cookie / token 明文不得进日志。** 仓库已有两层防护,新增脚本必须遵守:

**1. 只打印截断后的前 50 字符并脱敏**(`hyb-daily-playwright.js:247`):

```js
function sanitizeLog(message) {
  // 脱敏 Cookie
  message = message.replace(/(__Secure-[^=]+)=([^;]{10})[^;]*/g, '$1=$2***');
  message = message.replace(/(__Host-[^=]+)=([^;]{10})[^;]*/g, '$1=$2***');
  // 脱敏 JWT
  message = message.replace(/(eyJ[A-Za-z0-9_-]{10})[A-Za-z0-9_.-]+/g, '$1***');
  return message;
}
```

**2. 打印服务端响应对象前先递归抹除敏感字段**(`hyb-farm.js:595`):

```js
function scrubResponse(value) {
  if (!value || typeof value !== 'object') return value;
  const clone = Array.isArray(value) ? [...value] : { ...value };
  for (const key of Object.keys(clone)) {
    if (/cookie|token|authorization|csrf|clearance|nonce/i.test(key)) {
      clone[key] = '[redacted]';
    } else if (clone[key] && typeof clone[key] === 'object') {
      clone[key] = scrubResponse(clone[key]);
    }
  }
  return clone;
}
```

> **已知例外(有意保留)**:`runanytime-browser.js:275` 会打印完整新 Cookie。该站点 refresh token **每次轮换**且 HttpOnly,青龙环境下写回环境变量失败时必须让用户手动更新,否则账号掉登录。这是有意设计,不要"顺手修掉"。

---

## 三、青龙通知

### 加载方式:多路径 + 降级

脚本**不**用 `require('sendNotify')` 裸引用,而是沿候选路径查找(青龙面板的脚本目录布局因部署方式而异)。

参照实现 `gongyizhan/sendNotify.js:15` 候选列表(该文件本身是通知模块,同时内含查找逻辑供复用):

```js
const candidates = [
  path.join(process.cwd(), 'sendNotify.js'),
  path.join(process.cwd(), 'notify.js'),
  path.join(process.cwd(), 'function', 'sendNotify.js'),
  path.join(process.cwd(), 'function', 'notify.js'),
  path.join(__dirname, '..', 'sendNotify.js'),
  path.join(__dirname, '..', 'notify.js'),
  path.join('/ql', 'data', 'scripts', 'sendNotify.js'),
  path.join('/ql', 'data', 'scripts', 'notify.js'),
  path.join('/ql', 'scripts', 'sendNotify.js'),
  path.join('/ql', 'scripts', 'notify.js'),
];
```

三个必备细节:

1. **去重**:`[...new Set(candidates)]`
2. **自引用保护**:`hyb-cards-draw.js` 的 `getQinglongNotifyModule()` 用 `isSameFile()` 跳过自己,避免 `require` 自身造成递归
3. **导出形态兼容**:通知模块可能是函数,也可能挂在 `sendNotify` / `default` 上

```js
const sendNotify = typeof mod === 'function'
  ? mod
  : typeof mod?.sendNotify === 'function'
    ? mod.sendNotify
    : typeof mod?.default === 'function'
      ? mod.default
      : null;
```

### 降级行为

**加载失败或发送失败时,一律降级为 `console.log`,绝不让通知问题中断任务。**

参照 `anyrouter.js:26` / `bohe.js:131`:

```js
async function notify(title, content) {
  try {
    // ... 查找并调用
    if (sendNotify) return await Promise.resolve(sendNotify(title, content));
  } catch (error) {
    console.error(`[AnyRouter] 青龙通知发送失败: ${error.message}`);
  }
  console.log(`\n${title}\n${content}`);
  return false;
}
```

注意 `console.error` 只打印 `error.message`,**不打印整个 error 对象**(可能含响应体里的凭证)。

### 失败通知必须对齐下游分流关键词(青龙 Node-RED)

青龙的通知链路是 `sendNotify.js` → `POST /ql-notify` → Node-RED function node「配置区:双TG Bot分流」→ 双 TG Bot。分流**唯一依据**是通知文本里的关键词:

- 关键词表:`已失效, 无效用户, 失效, cookie失效, ck失效, 登录失效, 账号失效, 账号过期, 重新登录, 发生异常, invalid, expired`(该表由 Node-RED 节点维护,**不在本仓库**,改动需人工同步)
- 待判定文本 = **标题 + 正文拼接**(标题也参与匹配)
- 匹配规则:大小写不敏感;对「原文小写」与「去掉全部空白后的紧凑串」**各匹配一次**,任一命中即算
- 命中 → 失效提醒 Bot(且 `sendNormalWhenAlert: false`,**不再**发普通 Bot);未命中 → 普通 Bot

因此失败文案必须按失败类别对齐关键词:

| 类别 | 要求 | 示例 |
|------|------|------|
| 凭证 / 登录类失败 | 标题或正文**至少**覆盖 `已失效`(或 `失效`/`cookie失效`)与 `重新登录`,并保留要更新的环境变量名 | `❌ Cookie 已失效,请重新登录获取后更新 HYB_FARM_COOKIE` |
| 顶层异常兜底 | 文案统一以 `❌ 发生异常:` 开头 | `❌ 发生异常:执行失败\n\n错误类型: ...` |
| 非凭证类失败(网络超时、`schema_changed`、任务级失败) | **不得**引入上述关键词,避免误入失效 Bot | `⚠️ 进度接口结构未识别(schema_changed),请维护`、`❌ 签到失败: ...` |

等价匹配函数(人工核对 / 新增脚本自检用,与 Node-RED 侧一致):

```js
const ALERT_KEYWORDS = '已失效,无效用户,失效,cookie失效,ck失效,登录失效,账号失效,账号过期,重新登录,发生异常,invalid,expired';
function matchesAlertRouting(text) {
  const lower = String(text).toLowerCase();
  const compact = lower.replace(/\s+/g, '');
  return ALERT_KEYWORDS.split(',').map(k => k.trim()).filter(Boolean)
    .some(k => lower.includes(k) || compact.includes(k.replace(/\s+/g, '')));
}
```

**新增脚本收尾自检**:把凭证/登录类失败文案与顶层兜底文案喂给 `matchesAlertRouting`,必须返回 `true`;把网络超时、`schema_changed`、任务级失败文案喂进去,必须返回 `false`。

### 发送时机

| 时机 | 要求 |
|------|------|
| 正常结束 | 发送结果汇总(各账号成功/失败明细) |
| 异常结束 | **必须也发**。参照 `autosing.py:220`:`send("签到结果", "❌ 发生异常:签到失败\n\n" + str(e))` |
| 高频脚本 | 需**通知冷却**,避免每半小时一次失败刷屏 —— `hyb-farm.js:18` 定义 `NOTIFICATION_COOLDOWN_MS = 12 * 60 * 60 * 1000`,由 `buildNotificationPlan()`(`hyb-farm.js:1763`)决定本轮是否真的发送 |

若脚本以 `*/30 * * * *` 之类高频运行且可能持续失败,必须实现冷却,否则用户会关掉通知。

---

## 相关文档

- 失败时的错误分类与文案 → [error-handling.md](./error-handling.md)
- 变量命名与必需/可选标注 → [env-and-config.md](./env-and-config.md)