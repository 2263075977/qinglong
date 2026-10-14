# whos-daily 失败通知未路由到失效提醒 Bot

## Goal

`whos.tv 每日任务`(`gongyizhan/whos-daily.js`)在 Cookie 失效等失败场景下,通知能可靠进入青龙 Node-RED 分流的**失效提醒 Bot(alertBot)**分支;不留任何「通知已发出但走错机器人」的失败路径。

用户价值:凭证过期时第一时间收到失效提醒,不再需要翻普通通知频道才发现任务已经静默失败多日。

## Background

用户链路:`青龙面板` → `sendNotify.js` → `POST /ql-notify` → Node-RED function node「配置区:双TG Bot分流」→ 双 TG Bot。

### 已核实事实(仓库内证据)

**Node-RED 侧(用户提供 flow JSON,不在本仓库)**

- `http in` 节点:`POST /ql-notify`;function node id `48e217ad36f1fc36`,3 个输出:`[0]` 普通 Bot、`[1]` 失效提醒 Bot、`[2]` HTTP Response 回青龙。
- 判定用的关键词表(唯一分流依据):
  `已失效, 无效用户, 失效, cookie失效, ck失效, 登录失效, 账号失效, 账号过期, 重新登录, 发生异常, invalid, expired`
- 匹配规则:大小写不敏感;对「原文小写」和「去掉全部空白后的紧凑串」**各匹配一次**;匹配前会剥掉 `过滤 失效贴吧 0个` 这类行。
- 待判定文本来源:`title/subject/name/topic` + `content/text/desp/description/message/body/summary`(即标题与正文**拼接后**一起判定)。
- CONFIG:`enableMaskSensitive: true`、**`sendNormalWhenAlert: false`**(判为失效类的通知**只**发失效 Bot,不再发普通 Bot)、`maxTelegramLength: 3900`、`tgApiHost: https://api.telegram.org`。
- 结论:通知能否走失效提醒 Bot,**100% 取决于标题+正文是否含上表关键词**。

**whos-daily 侧的失败文案**(`gongyizhan/whos-daily.js`)

| # | 触发路径 | 代码位置 | 发给通知的正文(标题恒为 `whos.tv 每日任务`) | 是否命中关键词 |
|---|---|---|---|---|
| 1 | 会话验证失败,`formatResult` 提前返回 | `whos-daily.js:1294-1297` | `账号: 未知` / `❌ 登录失败,请更新 WHOS_COOKIE` | **否** |
| 2 | 中途 `auth_failed` 熔断(`fatal` 后剩余任务标 `未执行`) | `whos-daily.js:1367-1374` | `账号: X` / `❌ 评分失败 0/5: 未执行` … / `请更新环境变量 WHOS_COOKIE` | **否** |
| 3 | 顶层异常兜底 | `whos-daily.js:1454-1458` | `❌ 执行失败` / `错误类型: <type>` / `错误信息: <msg>` | **否**(`network_error`/`runtime_error`);仅当 `<type>` 为 `auth_failed` 且 `<msg>` 恰含 `登录失效` 时**偶然命中** |

- 路径 3 的偶然命中来源是 `whos-daily.js:757` 抛出的 `获取任务进度失败:登录失效`(type `auth_failed`)——该字符串是抛错信息,**不属于任何通知文案**;路径 1 直接吞掉了它,所以最常见的「Cookie 失效」场景反而必然不命中。
- 复现验证(本地桩数据,占位实现关键词匹配):

  ```
  formatResult({errors:[{type:'auth_failed'}]})   →  "账号: 未知\n❌ 登录失败,请更新 WHOS_COOKIE"  命中 []
   formatResult({signin:{...}, errors:[auth_failed]}) →  "…请更新环境变量 WHOS_COOKIE"         命中 []
  "❌ 执行失败\n\n错误类型: network_error\n…"                                                 命中 []
  ```

- 关键词表里有 `登录失效` 而脚本写的是 `登录失败`;表里有 `失效`/`已失效` 而脚本的失败通知正文一个都没写。**这是根因。**

**横向比对(仓库同层脚本的失败文案覆盖)**

| 脚本 | 覆盖的关键词 |
|---|---|
| `anyrouter.js` | 已失效 / 发生异常 / invalid / expired |
| `aokicore-browser.js` | 已失效 / 重新登录 / 发生异常 / invalid / expired |
| `laomo-browser.js` | 已失效 / 发生异常 / invalid / expired |
| `bohe.js` `elysia.js` `hyb-cards-draw.js` | 已失效 / 发生异常 |
| `hyb-farm.js` | 已失效 / 发生异常 / invalid / expired |
| `sharedchat-vibe-claim.js` | 登录失效 / 重新登录 / 发生异常 / invalid / expired |
| `autosing.py` | cookie失效 / 发生异常 |
| **`whos-daily.js`** | **仅 `登录失效`,且只出现在抛错信息里,通知文案零覆盖 → 唯一漏网脚本** |

- 结论:让 whos-daily 的失败通知文案对齐关键词表,是恢复既有约定的最小改动;无需新增机制。

**其他已核实事实**

- 通知**确实已发出**:`whos-daily.js:1449` 无差别 `await sendNotification(TASK_TITLE, resultText)`,`auth_failed` 路径会走到;`decideExitCode` 返回 `1`。用户也确认普通通知能到达 Node-RED。→ 问题不在「发不发」,在「文案关键词」。
- 仓库内不存在任何 "失效提醒" / Node-RED flow / webhook 相关资产:`grep -rl "ql-notify|alertBotToken|normalBotToken|Node-RED"` 仅命中本任务目录自身。

### 相关既有约定(`.trellis/spec/qinglong/`)

- `logging-and-notify.md`:异常结束**必须也发**通知;通知失败降级为 `console.log`,不中断任务;凭证不得进日志/通知。
- `error-handling.md:206`:「凭证失效 → 提示更新对应 `*_COOKIE` 变量,不发原始响应」;`:113` 给出 `Cookie 已失效或未登录,请更新 HYB_FARM_COOKIE` 的措辞范例。

## Requirements

- **R1** `gongyizhan/whos-daily.js` 在「会话验证失败」场景发出的通知(标题或正文)必须命中 Node-RED 关键词表,进入失效提醒 Bot。当前该路径文案 `登录失败,请更新 WHOS_COOKIE` 不命中。
- **R2** 「中途 `auth_failed` 熔断」场景的通知同样必须命中(当前结尾只有 `请更新环境变量 WHOS_COOKIE`)。
- **R3** 顶层异常兜底的通知必须命中(至少覆盖 `发生异常`,与 `anyrouter.js` / `bohe.js` / `hyb-cards-draw.js` 的 `❌ 发生异常:执行失败` 一致)。
- **R4** 文案必须**同时**保留用户可操作信息:明确指出更新哪个环境变量 `WHOS_COOKIE`,并说明需要「重新登录获取」。不得只堆关键词而丢失指引。
- **R5** 不引入新依赖、不新建共享错误基类、不新建 `package.json`;保持脚本自包含。
- **R6** 不改变既有成功/中性文案(签到成功、已签到、评分/收藏/分享明细等),不改动 `decideExitCode` 的退出码语义。
- **R7** 通知与日志继续遵守脱敏约定,新增文案不引入任何凭证字符串。
- **R8** 同步更新 `.trellis/spec/qinglong/` 中关于失败通知文案的约定,把「关键词对齐」固化为可检查的规则,避免下一个新脚本再漏。

### 已决策(用户裁定)

- **D1(分流范围 = 方案 A)** 只有「凭证/登录类失败」与「顶层异常兜底」需要进入失效提醒 Bot。
  - **纳入**:R1(会话验证失败)、R2(中途 `auth_failed` 熔断)、R3(顶层异常兜底)。
  - **不纳入**:网络超时、接口结构变更(`schema_changed`)等非凭证类失败,继续只走普通 Bot。
  - 理由:告警频道保持高信噪比,避免偶发超时天天刷屏;凭证失效才是需要人工立刻介入的类别。
  - 推论:Node-RED 关键词表**无需改动**;改造只在脚本侧文案。
  - 推论:whos-daily 的 `⚠️ 进度接口结构未识别(schema_changed),请维护` 与 `❌ 签到失败` / `❌ 评分失败` 等任务级文案**保持原样**,不追加失效关键词。

## Acceptance Criteria

- [ ] **AC1** 桩数据驱动 `formatResult({errors:[{stage:'profile',type:'auth_failed',message:'登录失败'}]})` 得到的文本,经「大小写不敏感 + 去空白紧凑串」双重匹配后,至少命中 `已失效`、`失效`(或 `cookie失效`)、`重新登录` 之一。
- [ ] **AC2** 桩数据场景「签到成功后评分阶段 `auth_failed` 熔断」的输出文本同样至少命中上述关键词之一。
- [ ] **AC3** 顶层异常兜底文本含 `发生异常`,即命中关键词表。
- [ ] **AC4** 凭证失效路径的输出文本必须含 `WHOS_COOKIE` 字样(用户仍知道要改哪个变量)。范围限定为 AC1/AC2 两个场景;顶层异常兜底(AC3)由 `error.message` 动态拼接,**仅当**该异常本身源于凭证问题(如 `whos-daily.js:731` 抛出、经 `:1380` 归为 `auth_failed`)时才附带变量名 —— 非凭证类顶层异常不得挂上「更新 Cookie」指引(D1)。
- [ ] **AC5** 使用与 Node-RED 等价的匹配函数复核:上述三条文案命中数 `> 0`;同时确认改造前同样输入命中数为 `0`(回归对照)。
- [ ] **AC6** `node --check gongyizhan/whos-daily.js` 通过(仓库唯一可自动化验证手段)。
- [ ] **AC7** 新增/修改的文案不出现完整或部分 Cookie、token、Bearer 串。
- [ ] **AC8** `git diff` 仅触及 `gongyizhan/whos-daily.js` 与 `.trellis/spec/qinglong/*`(外加本任务目录);成功路径文案无改动。
- [ ] **AC9** spec 中新增的约定条目能让检查者仅凭文档判定「新脚本的失败文案是否会被分流到失效 Bot」。
- [ ] **AC10(负向,对应 D1)** 非凭证类失败文案**不得**引入失效关键词:`⚠️ 进度接口结构未识别(schema_changed),请维护`、`❌ 签到失败: …`、`❌ 评分失败 …`、`❌ 收藏失败 …`、`❌ 分享失败 …` 经同一匹配函数复核后,命中数仍为 `0`。

## Out of Scope

- 修改 Node-RED flow 本身(它不在本仓库)。**D1 已裁定无需改动关键词表**。
- 让**所有** whos-daily 失败(如网络超时)都进失效提醒 Bot —— 是否纳入由「待定决策」确定。
- 修复 Cookie 本身(文案修复不能让过期 Cookie 复活;需用户在青龙面板更新 `WHOS_COOKIE`)。
- 其他脚本的文案改造(已核实均已命中)。
- 为 whos-daily 增加通知冷却机制(它是每日一次的低频任务)。

## Notes

- 用户明确要求:**本对话只完成任务创建与规划,不执行实现**;实现放到新对话。