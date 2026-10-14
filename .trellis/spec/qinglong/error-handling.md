# 错误处理

> 自定义错误类、顶层兜底、以及 429 限流的退避重试。

---

## 核心原则

> **任何异常都不能让用户在面板里看到裸堆栈。**

面板日志是用户唯一的反馈渠道。用户看到 `TypeError: Cannot read property 'x' of undefined` 时无从下手;看到 `请更新 HYB_FARM_COOKIE` 时就知道做什么。

三条落地要求:

1. 每轮任务由**顶层 catch 兜底**,把错误翻译成中文可行动文案
2. 失败**也要发通知**(见 [logging-and-notify.md](./logging-and-notify.md))
3. 设置 `process.exitCode = 1`,让面板判定任务失败

---

## 一、每站点一个错误类

实测 9 个 JS 脚本各有自己的错误类,命名 = `<站点名>Error` extends `Error`:

| 脚本 | 错误类 |
|------|--------|
| `anyrouter.js` | `AnyRouterError` |
| `aokicore-browser.js` | `AokiCoreBrowserError` |
| `bohe.js` | `SignInError` |
| `hyb-cards-draw.js` | `HybCardsError` |
| `hyb-farm.js` | `HybFarmError` |
| `laomo-browser.js` | `LaomoBrowserError` |
| `runanytime-browser.js` | `RunAnytimeError` |
| `sharedchat-vibe-claim.js` | `SharedChatClaimError` |
| `whos-daily.js` | `WhosDailyError` |

**不要**建共享的 `AppError` 基类 —— 与单脚本自包含原则冲突(见 [directory-structure.md](./directory-structure.md))。

### 构造签名:两种并存

**带类型标签**(适合需要按类型分流处理的脚本):

```js
// anyrouter.js:18 —— type 决定顶层如何翻译文案
class AnyRouterError extends Error {
  constructor(type, message) {
    super(message);
    this.name = 'AnyRouterError';
    this.type = type;
  }
}
```

**带详情对象**(适合需要打印服务端响应的脚本):

```js
// hyb-cards-draw.js:17
class HybCardsError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'HybCardsError';
    this.details = details;
  }
}
```

> ⚠️ `anyrouter.js` 与 `hyb-farm.js` 的 `HybFarmError` 都带 `type`,但**实测没有任何脚本给 `type` 定义过集中常量表** —— 类型值是调用处直接传的字符串字面量。新增类型时保持就地字面量,不要为凑"枚举"新建常量文件。

### `details` 打印前必须脱敏

带 `details` 的错误类,顶层打印时要先过 `scrubResponse()`(实现见 [logging-and-notify.md](./logging-and-notify.md)):

```js
// hyb-farm.js:1956
if (error instanceof HybFarmError && error.details && Object.keys(error.details).length > 0) {
  console.error(`${LOG_PREFIX} 详细信息: ${JSON.stringify(scrubResponse(error.details), null, 2)}`);
}
```

---

## 二、顶层兜底结构

统一形状:**`main()` / `run()` 返回 Promise,顶层 catch 翻译 + 通知 + 设退出码**。

```js
// bohe.js:459 —— 带类型标签的翻译写法
if (require.main === module) {
  run().catch((error) => {
    const errorMsg = error instanceof SignInError
      ? error.message
      : `未知错误: ${error.message || String(error)}`;

    console.error(`[up.x666] ❌ 执行失败`);
    console.error(`[up.x666] ${errorMsg}`);

    if (error instanceof SignInError && error.details && Object.keys(error.details).length > 0) {
      console.error(`[up.x666] 详细信息: ${JSON.stringify(error.details, null, 2)}`);
    }

    sendQinglongNotification(TASK_NAME, `❌ 发生异常:执行失败\n\n${errorMsg}`)
      .finally(() => {
        process.exitCode = 1;
      });
  });
}
```

```js
// hyb-farm.js:1945 —— 按 type 分流成可行动文案
run().catch(async (error) => {
  const errorMsg = error instanceof HybFarmError && error.type === 'auth_failed'
    ? 'Cookie 已失效或未登录,请更新 HYB_FARM_COOKIE'
    : error instanceof HybFarmError && error.type === 'challenge_required'
      ? '站点要求 CAP/Cloudflare 验证,请在浏览器完成验证后重试'
      : error instanceof HybFarmError
        ? error.message
        : `未知错误: ${error?.message || String(error)}`;
  // ...
  process.exitCode = 1;
});
```

要点:

| 要点 | 说明 |
|------|------|
| `require.main === module` | 有 `module.exports` 的脚本必须加,否则被 require 时会执行任务 |
| 未知错误套一层 | `未知错误: ${error?.message \|\| String(error)}`,保留原始信息便于排查 |
| 通知先于退出码 | 用 `.finally()` 保证通知发出后再设 `process.exitCode = 1` |
| 用 `process.exitCode` 不用 `process.exit()` | 让异步通知有机会写完,避免截断日志 |

Python 侧的等价结构见 `fuliba/autosing.py:184-220`:整轮包在 `try/except Exception`,异常时 `print` + `send(...)`。**Python 版未设非零退出码**(现状,不做改造)。

---

## 三、429 限流:单独分类 + 预算退避

这是仓库里唯一有完整退避实现的场景,参照 `hyb-farm.js`。

### 为什么要单独分类

站点前置 Cloudflare 等候室(`/__vwr/`)在**同一出口 IP 并发过多**时返回 HTTP 429 + `Retry-After`。关键:请求**未到达源站**,重试安全 —— 而其他 4xx/5xx 盲目重试可能重复提交。

源码注释(`hyb-farm.js:71-74`)写明了这个前提,改动前先读:

```js
// 站点前置 Cloudflare 等候室(/__vwr/):同一出口 IP 并发访问过多时返回 HTTP 429 + Retry-After。
// 请求未到达源站,重试安全;按 Retry-After 与指数退避取较大值等待,整轮运行共享等待预算。
const DEFAULT_RATE_LIMIT_WAIT_SEC = 120;  // 每次运行累计最多等待秒数,0 表示不重试
const RATE_LIMIT_BASE_DELAY_MS = 5 * 1000;
const RATE_LIMIT_MAX_DELAY_MS = 30 * 1000;
const STATE_REQUEST_GAP_MS = 1000;        // 状态查询的连续 GET 之间留间隔,避免突发并发
```

### 退避计算

```js
// hyb-farm.js:616 —— 指数退避与 Retry-After 取较大值,再夹到上限
function getRateLimitDelayMs(error, attempt) {
  const backoffMs = Math.min(RATE_LIMIT_BASE_DELAY_MS * 2 ** (attempt - 1), RATE_LIMIT_MAX_DELAY_MS);
  const retryAfterMs = getNumber(error?.details?.retryAfterMs, null);
  return Math.min(Math.max(backoffMs, retryAfterMs ?? 0), RATE_LIMIT_MAX_DELAY_MS);
}
```

`Retry-After` 解析同时支持**秒数**和 **HTTP 日期**两种格式(`parseRetryAfterMs`, `hyb-farm.js:608`),因为 Cloudflare 两种都出现过。

### 预算机制(关键)

```js
// hyb-farm.js:627
const budget = config.rateLimitBudget;
for (let attempt = 1; ; attempt += 1) {
  try {
    return await request(config, apiPath, options);
  } catch (error) {
    if (!(error instanceof HybFarmError) || error.type !== 'rate_limited' || !budget) throw error;
    const delayMs = getRateLimitDelayMs(error, attempt);
    if (budget.remainingMs < delayMs) {
      error.message += ',已用完本轮限流等待预算';
      throw error;
    }
    budget.remainingMs -= delayMs;
    // ... log + await wait(delayMs)
  }
}
```

**没有预算的退避会挂死 cron 任务。** 三个约束缺一不可:

1. 整轮运行**共享**一个 `rateLimitBudget`,不是每请求各自计数
2. 预算不足时**放弃并抛出**(附加"已用完本轮限流等待预算"),不再等
3. 仅 `rate_limited` 类型重试,其他错误**原样抛出**

新增脚本做退避时,把等待总预算也做成环境变量(如 `HYB_FARM_RATE_LIMIT_WAIT_SEC`,0 = 关闭重试)。

---

## 四、已知的失败分类

从提交历史与源码看,以下几类失败是**预期会被遇到的**:

| 类别 | 表现 | 处理 |
|------|------|------|
| 凭证失效 | 401/未登录 | 提示更新对应 `*_COOKIE` 变量,不发原始响应 |
| CAP / Cloudflare 验证 | 站点要求人机验证 | `challenge_required`:提示"请在浏览器完成验证后重试" |
| 429 限流 | HTTP 429 + `Retry-After` | 预算内退避重试,预算耗尽则报告 |
| 单账号失败 | 多账号中某个失败 | **不中断整轮**,记录该账号失败原因继续下一个 |
| 单次超时 | 请求超时 | 记录并继续;见提交 `whos.tv 循环内单次超时不再中断整轮任务` |

最后一条有明确历史:`whos-daily.js` 曾因循环内单次超时中断整轮,已修复为不再中断。**多账号 / 多轮循环中,单个失败必须被隔离**,不要 `throw` 到顶层。

> **失败文案的下游分流契约**:青龙 Node-RED「双 TG Bot 分流」按**标题 + 正文拼接**后的关键词决定通知进「失效提醒 Bot」还是普通 Bot。凭证 / 登录类失败文案**必须**覆盖 `已失效`(或 `失效`/`cookie失效`)与 `重新登录`,并保留要更新的 `*_COOKIE` 变量名;顶层异常兜底统一以 `❌ 发生异常:` 开头;网络超时、`schema_changed`、任务级 `❌ 签到失败` 等**非凭证类失败不得引入这些关键词**。关键词表、匹配规则与自检函数见 [logging-and-notify.md](./logging-and-notify.md) 的「失败通知必须对齐下游分流关键词」。

---

## 五、常见错误(避免重犯)

| 反模式 | 为什么错 |
|--------|----------|
| `throw new Error('cookie missing')` | 用户不知道要做什么。给出变量名 + 配置步骤 |
| 顶层不设 `process.exitCode = 1` | 面板显示任务成功,失败被静默 |
| 用 `process.exit(1)` | 截断异步通知,日志可能不完整 |
| 打印整个 error / 响应对象 | 可能含 Cookie、token(`details` 必须先过 `scrubResponse`) |
| 循环内错误直接 `throw` | 一个账号失败导致其余账号都不跑 |
| 无限重试 | 挂死 cron 任务;必须有等待预算 |
| 对非 429 错误也重试 | 请求已到达源站,重复提交可能重复操作 |
| 把已知失败当未知错误处理 | 用户看到"未知错误"而实际只需更新 Cookie |

---

## 相关文档

- 日志前缀与脱敏函数 → [logging-and-notify.md](./logging-and-notify.md)
- 限流相关变量 → [env-and-config.md](./env-and-config.md)
- 本地能做的检查 → [quality-guidelines.md](./quality-guidelines.md)