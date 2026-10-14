# 环境变量与配置

> 账号通过环境变量传入。本文件记录**实测的命名现状**,不做理想化改造。

---

## 为什么全靠环境变量

青龙面板用环境变量管理账号:用户在面板里填变量,面板在跑脚本时注入。所以:

- **不要在脚本里硬编码 Cookie / 密码**
- **不要引入 `.env` 作为必需依赖** —— 只有部分脚本用 `loadDotEnv()` 支持本地调试(见下文)
- 缺失必需变量时,不抛裸错误,而是给出**中文配置指引**(见下方示例)

---

## 一个脚本 = 一个站点前缀

命名规则:环境变量用**站点前缀大写**,前缀与脚本对应。

| 脚本 | 前缀 | 实测变量 |
|------|------|----------|
| `anyrouter.js` | `ANYROUTER_` | `ANYROUTER_COOKIE` |
| `aokicore-browser.js` | `AOKICORE_` | `AOKICORE_ACCOUNTS`、`AOKICORE_USER_ID`、`AOKICORE_ACCOUNT_NAME`、`AOKICORE_BROWSER_HEADLESS`、`AOKICORE_BROWSER_TIMEOUT_MS`、`AOKICORE_BROWSER_USER_AGENT` |
| `bohe.js` | `UP_X666_` | `UP_X666_COOKIE`、`UP_X666_BASE_URL`、`UP_X666_TIMEOUT_MS` |
| `elysia.js` | `ELYSIA_` | `ELYSIA_ACCOUNTS` |
| `hyb-cards-draw.js` | `HYB_CARDS_` | `HYB_CARDS_COOKIE`、`HYB_CARDS_ACCOUNT`、`HYB_CARDS_ALLOW_PAID`、`HYB_CARDS_BASE_URL`、`HYB_CARDS_TIMEOUT_MS`(+ `HYB_COOKIE`、`HYBGZS_COOKIE` 兑底) |
| `hyb-daily-playwright.js` | `HYB_` | `HYB_COOKIE` / `HYB_DASHBOARD_COOKIE` / `HYBGZS_COOKIE`(三选一)、`HYB_HEADLESS`、`HYB_BLOCK_RESOURCES`、`HYB_DEBUG` |
| `hyb-farm.js` | `HYB_FARM_` | 见 [hyb-farm 变量组](#hyb_farm-变量组最复杂的一组) |
| `laomo-browser.js` | `LAOMO_` | `LAOMO_ACCOUNTS_JSON`、`LAOMO_COOKIE`、`LAOMO_USERNAME`、`LAOMO_SITE_URL`、`LAOMO_BROWSER_HEADLESS`、`LAOMO_BROWSER_TIMEOUT_MS` |
| `newapi.js` | `METAPI_` | `METAPI_ACCOUNTS_JSON`、`METAPI_CONFIG_PATH` |
| `runanytime-browser.js` | `RUNANYTIME_` | `RUNANYTIME_ACCOUNTS`、`RUNANYTIME_USER_AGENT`、`RUNANYTIME_POW_TIMEOUT_MS`、`RUNANYTIME_TRACE` |
| `sharedchat-vibe-claim.js` | `SHAREDCHAT_` | `SHAREDCHAT_USERNAME`、`SHAREDCHAT_PASSWORD`、`SHAREDCHAT_TIMEOUT_MS`、`SHAREDCHAT_CHALLENGE_WAIT_MS`、`SHAREDCHAT_USER_AGENT`、`SHAREDCHAT_CLAIM_REASON_PREFIX` |
| `whos-daily.js` | `WHOS_` | `WHOS_COOKIE`、`WHOS_BASE_URL`、`WHOS_TIMEOUT_MS`、`WHOS_RATE_SCORE`、`WHOS_FRAME_ID_MAX`、`WHOS_FRAME_ID_SPAN`、`WHOS_KEEP_FAVORITES` |
| `fuliba/autosing.py` | `FUBA` | `FUBA`(Cookie)、`FUBAUN`(用户名)、`FUBA_BASE_URL`、`FUBA_URL`、`FUBA_DOMAIN`、`FUBA_DOMAINS` |

⚠️ `newapi.js` 是压缩产物,前缀 `METAPI_` 与文件名不一致属正常现象,**不要为"对齐"而改名**。

---

## 凭证类变量:两种结尾并存

实测存在**两种**约定,新增脚本时**跟随同站点已有脚本**,不要强行统一:

| 结尾 | 含义 | 实例 |
|------|------|------|
| `_COOKIE` | 单账号 Cookie 字符串 | `ANYROUTER_COOKIE`、`UP_X666_COOKIE`、`WHOS_COOKIE`、`HYB_COOKIE`、`LAOMO_COOKIE` |
| `_ACCOUNTS` / `_ACCOUNTS_JSON` | 多账号(JSON 数组)或含额外凭证 | `AOKICORE_ACCOUNTS`、`ELYSIA_ACCOUNTS`、`RUNANYTIME_ACCOUNTS`、`LAOMO_ACCOUNTS_JSON`、`METAPI_ACCOUNTS_JSON` |

少数脚本需要**账号密码而非 Cookie**:`sharedchat-vibe-claim.js`(`SHAREDCHAT_USERNAME` + `SHAREDCHAT_PASSWORD`)—— 因为它要走真实登录流程并捕获 token。

---

## 可选变量的四种固定角色

| 角色 | 命名 | 说明 | 实例 |
|------|------|------|------|
| 站点地址可覆盖 | `*_BASE_URL` / `*_SITE_URL` | 站点换域名时不改代码(这类站点换域名频繁) | `HYB_FARM_BASE_URL`、`UP_X666_BASE_URL`、`LAOMO_SITE_URL` |
| 超时 | `*_TIMEOUT_MS` | 统一毫秒单位,后缀必须带 `_MS` | `HYB_FARM_TIMEOUT_MS` |
| 浏览器行为 | `*_BROWSER_HEADLESS` / `*_HEADLESS` | 是否无头 | `AOKICORE_BROWSER_HEADLESS`、`HYB_HEADLESS` |
| 浏览器 UA | `*_USER_AGENT` | `cf_clearance` 与 UA 绑定,必须与取 Cookie 时一致 | `RUNANYTIME_USER_AGENT` |

跨脚本共享的**唯一**变量是 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`(所有 Playwright 脚本都读它)。改它的解析逻辑前先 grep 全部引用点。

---

## 多账号写法

JSON 数组,每项一个账号:

```bash
LAOMO_ACCOUNTS_JSON='[{"cookie": "session=xxx", "username": "账号1"}, {"cookie": "session=yyy", "username": "账号2"}]'
```

解析时的既有约定(`laomo-browser.js:697` 起是参照实现):

- 必须校验是数组,否则报 `LAOMO_ACCOUNTS_JSON 必须是 JSON 数组`
- **逐项校验必需字段**,并**指出下标**:`LAOMO_ACCOUNTS_JSON[1] 缺少有效 cookie 字段`
- `JSON.parse` 包在 try/catch 里,失败时把原始错误消息带上:`LAOMO_ACCOUNTS_JSON 解析失败: ${error.message}`

不要因为账号格式不对就静默退出 —— 用户需要知道**哪个下标**写错了。

---

## 缺失必需变量时的报错格式

不抛 `new Error('cookie missing')`,而是给**中文步骤指引**。参照 `whos-daily.js:157`:

```js
throw new WhosDailyError(
  '缺少必需环境变量 WHOS_COOKIE\n' +
  '...\n' +
  '  6. 设置环境变量: WHOS_COOKIE="<复制的内容>"\n',
);
```

参照 `hyb-daily-playwright.js:243` 的多候选写法(当多个变量名任一可接受时):

```
'❌ 未找到 Cookie 环境变量\n请设置以下任一变量:\n  - HYB_COOKIE\n  - HYB_DASHBOARD_COOKIE\n  - HYBGZS_COOKIE'
```

---

## `.env` 只用于本地调试

`bohe.js` 和 `hyb-cards-draw.js` 实现了 `loadDotEnv()`,在 `process.cwd()` 和父目录找 `.env`。

**关键约定**(`bohe.js:43`):

```js
if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;
```

**已存在的环境变量优先,`.env` 不覆盖。** 这保证青龙面板注入的值不会被仓库里的 `.env` 顶掉。新增脚本若支持 `.env`,必须遵守这条。

---

## `hyb-farm` 变量组(最复杂的一组)

`hyb-farm.js` 有约 17 个 `HYB_FARM_` 变量,因为它是**策略可配置**的(农场自动化)。分四类:

| 类别 | 变量 |
|------|------|
| 账号与地址 | `HYB_FARM_ACCOUNT`、`HYB_FARM_BASE_URL`、`HYB_FARM_TIMEOUT_MS` |
| 种植策略 | `HYB_FARM_SEED_ID`、`HYB_FARM_MAX_PLANT`、`HYB_FARM_QUANTITY`、`HYB_FARM_MIN_ENERGY`、`HYB_FARM_DEFAULT_ACTION`、`HYB_FARM_PLANT_BODY` |
| 售卖策略 | `HYB_FARM_AUTO_SELL`、`HYB_FARM_SELL_RATIO`、`HYB_FARM_FORCE_SELL_USAGE`、`HYB_FARM_SEED_RESERVE`、`HYB_FARM_AUTO_EXECUTE` |
| 限流与等待 | `HYB_FARM_RATE_LIMIT_WAIT_SEC`、`HYB_FARM_WAIT_WINDOW_MIN`、`HYB_FARM_WAIT_ROUNDS` |

**改动策略变量时必读源码注释。** 例如 `DEFAULT_SEED_RESERVE = 0` 上方有一段说明:之所以可以保留 0,前提是"开始自动卖出前已把主种种子全部种下",若日后支持"买种子囤着分批种",此默认值就必须调高,否则未种的种子会被当盈余卖掉(`hyb-farm.js:62-65`)。这类**前置条件必须留在代码注释里**,不要只写进文档。

---

## 相关文档

- 脚本头部的 `cron` + `new Env` 声明 → [logging-and-notify.md](./logging-and-notify.md)
- 站点 429 限流时的退避变量 → [error-handling.md](./error-handling.md)