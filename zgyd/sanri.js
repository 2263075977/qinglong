#!/usr/bin/env node
// cron: 35 8 * * *
// new Env('中国移动幸运三日签');
// description: 中国移动 App「幸运三日签」每日签到 + 累计抽奖（COC3 画布活动；token 优先、现签兜底）
/**
 * 这条活动到底是什么（规则来自活动页；接口契约见
 * .trellis/tasks/11-25-sanri-signin/research/sanri-contract.md，2026-11-25 实测）
 *   每天签一次；第 1 天直发 2GB 流量日包（签到直发，不需要额外领券接口）；
 *   累计 2 天 / 3 天各给一次抽奖（100MB 流量券·2 元话费券 / 500MB·5 元·66 元）；
 *   之后每签满 3 天再给一次抽（66 / 88 / 100 元话费券，视库存）。
 *
 * 凭证模型：三级来源链（2026-11-25 二次实测；研究文档 §8.1–8.10）
 *   业务请求的鉴权只有一个头：phone: <token>（实测 36 字符，形如 T8QI…0524）。
 *   谁能给出这个 token，谁就是凭证来源。**逐级尝试，前一级拿到就停**：
 *
 *   ① SANRI_PHONE —— 用户直接给的 token（多账号用 & 或换行分隔，保序去重）。
 *      用户显式给了就**只**用它：它还能不能用，只靠下面那个只读探针判（探死即零写请求中止），
 *      **不会**退回去试 mint —— 显式配置被悄悄换成别的凭证，比直接失败更难排查。
 *   ② SANRI_SURGE_URL + SANRI_SURGE_KEY —— 从 Surge HTTP API 里捡页面登录时带出来的 phone 头。
 *      · 只配了这两项也**能跑**（不需要 SANRI_PHONE / SANRI_ACCOUNTS）：
 *        脚本会建 1 个**占位账号**（不含任何凭证）把流程送进 ②，避免「没有 account 就走不到 ②」。
 *        捡不到 token 时落「未拿到可用凭证 + 4 步指引」，不会报「未配置」。
 *      · 先查 GET {SANRI_SURGE_URL}/v1/requests/recent（只留最近 50 条）
 *      · 再查抓包会话（/v1/capture/sessions 取最新会话 → /v1/capture/sessions/requests
 *        ?name=<会话名>&filter=dev.coc.10086.cn）：recent 只有 50 条，App 自己的轮询流量
 *        几十秒就能把活动请求挤出环形缓冲，只靠 recent 会经常捡不到
 *      · 只认 dev.coc.10086.cn 域的请求（别的 host 上的 phone 头不是本活动的凭证）
 *      · 只认 startDate 在 SANRI_TOKEN_MAX_AGE_MIN（默认 25 分钟）以内的，多个取最新
 *      · 网络失败 / 接口不通属**外部依赖问题**：告警后降级到下一级，不判账号失败
 *   ③ mint（兜底；本文件原有实现，一行没改）—— autoLogin → userLoginV2 → token
 *      ⚠️ 2026-11-25 实测该通道已被服务端关掉，见下面「mint 为什么降级成兜底」。
 *
 * mint 为什么降级成兜底（2026-11-25 实测，研究文档 §8.8–8.10）
 *   | 端点                                              | 结果     | 含义                        |
 *   | uamonekeylogin/autoLogin（旧，czrhd/qwhd 在用）    | 213245   | 旧一键登录通道已关闭（**临时**）|
 *   | uamonekeylogin/login（新，body 多 devToken/hyToken）| 110001   | 运营商网络/设备绑定         |
 *   ⚠️ 2026-11-26 复核：在 App 内重新登录后，上面的 213245 消失、autoLogin 恢复 000000。
 *      即那条通道是**运营商侧临时失效**，不是永久关闭 —— 恢复后 mint 立刻可用。
 *      真正让 mint 失败的是第二步少传了 jsid（见 loginBody 的注释），已修。
 *   签名本身是对的（HTTP 200 + 结构化业务码）：x-qen: 14 与「原始明文字节」都已验证
 *   （不能 JSON.parse 再 stringify —— 会把 \/ 变成 /，xs 就对不上了）。所以这两个码
 *   **不是**脚本 bug，也**不是**用户的 mint 模板过期：重抓模板一点用都没有。
 *   因此它们单独分类，文案不得出现「已失效 / 重新登录」（logging-and-notify.md 的要求），
 *   否则会把「通道关闭」灌进失效提醒 Bot，害用户去重抓一个不可能成功的模板：
 *     · 213245 → KIND.MINT_CLOSED   （一键登录旧通道已关闭）
 *     · 110001 → KIND.MINT_NETWORK  （运营商网络绑定：必须在手机蜂窝网络下由 App 完成）
 *
 * 唯一 100% 可靠的路径是 ①：token 对任意出口 IP 都有效（实测从本机调用成功），
 * 代价是寿命短（≤33 分钟，活动页自己每 25 分钟调一次 renewLogin 续命）。
 * 三条来源全部失败时，脚本**零业务请求**退出，并在通知里给出可执行的下一步（见 NO_CRED_HOWTO）。
 *
 * 环境变量（三个来源至少给一个）
 *   SANRI_PHONE=<token>[&<token>…]
 *     抓法：手机打开「中国移动」App → 幸运三日签活动页（刷新一次，页面登录后才会带 phone 头）
 *     → 抓包工具里找 dev.coc.10086.cn 的 POST 请求 → 复制请求头 phone 的值（实测 36 字符）。
 *     多账号用 & 或换行分隔（保序去重）。也接受 {"phone":"<token>","tel":"13800138000"} 写法
 *     （tel 只用于显示名与状态文件键，便于人眼核对；不填就显示成 phone1 / phone2）。
 *   SANRI_SURGE_URL=http://10.0.0.102:6171   Surge HTTP API 地址（iPhone「HTTP 抓包」开着即可）
 *   SANRI_SURGE_KEY=<X-Key>                  Surge HTTP API 的 Key（作为请求头 X-Key 发送；
 *                                           Surge 没设 Key 就留空，脚本会不发这个头）
 *   SANRI_SURGE_SESSION=auto                 会话扫描：auto=最新会话；off=不扫；<名字>=指定会话
 *   SANRI_TOKEN_MAX_AGE_MIN=25               Surge token 的有效期上限（分钟），超龄的不采用
 *   SANRI_ACCOUNTS=<mint 明文模板>[&…]        **只有 mint 兜底需要它**（见下）
 *     每项一个账号的 autoLogin 明文模板（JSON 对象）。抓法（2026-11-25 实测）：
 *       1. 抓包工具把**会话关键词**设成 10086.cn
 *          ⚠️ 硬门槛：关键词不含该域名时请求一条都录不到（recent 列表也看不到）。
 *       2. 找 POST https://client.app.coc.10086.cn/biz-orange/LN/uamonekeylogin/autoLogin
 *       3. 「复制为 cURL」→ 取请求体整个 JSON（含 xk 与 reqBody.cellNum），**原样**放进 mint:
 *          {"tel":"13800138000",
 *           "mint":{"xk":"<80 hex>","reqBody":{"cellNum":"<RSA 密文>",…},…}}
 *       4. ⚠️ mint 里的字段一个字都不要改、不要删：它会被原样 AES 加密回传，服务端要校验签名与
 *          明文结构；改了只会得到 retCode 非 000000（现签失败），不会「大概还能用」。
 *       5. 多账号用 & 或换行分隔。zgyd/czrhd.js 里配好的账号对象整块拷过来也能用 —— 多出来的
 *          provinceCode / cityCode / userCheckId / carrierOperator / yx 等字段本活动用不到，会被忽略。
 *     mint 账号与 SANRI_PHONE 的 token **按顺序配对**（第 n 个 mint 账号用第 n 个 token）；
 *     多出来的 token 自成账号（没有 mint，只能走 ①/② 这两级）。
 *
 * 环境变量（可选，前缀 SANRI_）
 *   SANRI_DRY_RUN=1        只读模式：仍会取凭证，但不发 task/sign、lottery/lottery，
 *                          且不落状态文件（也可用 --dry-run）
 *   SANRI_PUSH=0           不发青龙通知（默认 1）
 *   SANRI_NOTIFY_MODULE=…  显式指定 sendNotify.js 路径（一般不用，脚本会自动找）
 *   SANRI_TIMEOUT_MS=15000 单请求超时（毫秒）
 *   SANRI_STATE_FILE=<路径> 状态文件，默认 /ql/data/config/.sanri-state.json（目录不存在则落脚本目录）
 *   SANRI_DRAW_RETRY=0     抽奖**网络失败**的重试次数（默认 0）。业务码失败一律不重试 ——
 *                          服务端可能已经消耗了一次机会，重试等于白扔。
 *   SANRI_RETRY_MS=3000    上述重试的间隔（毫秒）
 *   SANRI_GAP_MS=1200      多账号之间的间隔（毫秒）；同账号并发易触发风控，故串行
 *   SANRI_VERIFY_ATTEMPTS=6   签到后回读复核的次数（含首读）
 *   SANRI_VERIFY_MS=2500      上述回读之间的间隔（毫秒）
 *   SANRI_TASK_ID=3157     活动任务 id（随活动批次变；2026-11 是 3157，10 月是 264xysrqtybld 那批）
 *   SANRI_CHANNEL_NO=P00000112150  渠道号（= 活动页 URL 里的 channelCode）
 *   SANRI_ACTIVITIES=<JSON> 抽奖活动表，默认三个活动（见 DEFAULT_ACTIVITIES）
 *   SANRI_REFERER=<URL>     referer 头，默认当月活动页 URL（pageKey 按月份换批次，换不动就改这里）
 *
 * 为什么 cron 是「每天一次」（2026-11-26 定稿）
 *   现签（③）可用时，token 随用随取，不需要高频撞窗口 —— 见下面「mint 为什么降级成兜底」的复核结论。
 *   早期曾用「每 10 分钟」，那是因为当时只有 Surge 捡 token 一条路，token 只有约 30 分钟寿命，必须高频撞上
 *   「用户打开活动页那一刻」。若你日后**只能**靠 Surge（容器连不到 autoLogin），再改回每 10 分钟。
 *   签到本身**没有时间窗口**（不像周三充值日要抢 8:00 整点），所以「什么时候撞上」不影响结果。
 *   ⚠️ 高频 ≠ 高频请求：状态文件记当天结论，**当天已签完 + 三个抽奖活动都有结论 → 后续运行
 *      零请求、零通知**直接跳过。真正会撞到业务接口的只有"当天第一次且拿到了新 token"那一轮。
 *   ⚠️ 反过来，拿不到凭证时高频运行会想推送 144 条通知 → 因此「未拿到凭证 / 凭证类失败」
 *      每账号**每天最多推送一次**（qwhd 的既有纪律，见 throttleNotice），其余只进面板日志。
 *   幂等：签到成功但抽奖失败时会只补抽、不再签。
 *   ⚠️ 例外：状态文件的键是 mobileMask / 账号显示名，靠 state.masks 里的「账号指纹 → 键」索引
 *      在取到凭证**之前**定位条目。升级后/加账号后的**第一次**运行没有索引，必须先取一次凭证。
 *
 * 现签（mint 兜底）的风控纪律（照抄 czrhd / qwhd，服务端额度是共享的）
 *   autoLogin 本质就是一次「App 一键登录」，调多会触发人脸识别甚至封 App：
 *     · 两次现签最小间隔 600s、每天最多 3 次（超了就本地跳过，不发请求）
 *     · retCode 233031 → 静默 10 分钟；214100 → 2 小时；214103 → 24 小时；213245 → 2 小时
 *     · 静默状态落状态文件（state.mint[<账号指纹>]），静默期间**不发** autoLogin
 *   ⚠️ 与 czrhd 共享服务端额度。因为 mint 现在只是兜底，正常情况下根本不会被调用。
 *   ⚠️ 静默/限频属于**正常跳过**（手滑多跑一次也会命中），只进面板日志、不进通知正文，
 *      否则一天几十条静默推送，用户会直接关掉通知。
 *
 * 接口（只允许用 research/sanri-contract.md 里实测确认的那几个，别去猜端点名）
 *   —— 凭证链路（SANRI_PHONE / Surge / mint）不是业务接口；下面的 {API} 全部要求已有的 phone 头：
 *   POST {API}/task/getTaskSignInfo            body {"taskId":3157,"needLimit":0}   外壳 resultCode
 *   POST {API}/task/sign                       body {"taskId":3157}                 外壳 resultCode
 *   POST {API}/lottery/residueLotteryCount     body {"activityId":<id>}             外壳 code:"200"
 *   POST {API}/lottery/lottery                 body {"activityId":<id>,"scene":1,"channelNo":"…"}
 *   两个外壳必须分开解析：task/* 看数字 `resultCode`，lottery/* 看字符串 `code`。
 *   注意 `lottery/checkConsecutiveLotteryVisibility` 会返回 success:false 但 data 有值 —— 本脚本不用它，
 *   也不要拿 `success` 字段判成败。
 *
 * ⚠️ lottery/* 还有一层二次嵌套（2026-11-25 dry-run 实测，用虚构 phone 打的只读接口）
 *   外层 code:"200" + success:true **不代表成功**，真正的业务码在 data.resultCode 里：
 *     {"code":"200","msg":"操作成功","data":{"resultCode":-516,
 *       "msg":"用户未登录或登录已失效","data":null},"success":true}
 *   → -516 是本活动**第二个**凭证类信号（第一个是 code:"40"）。不处理这一层会两头出错：
 *     查次数会被误报成「契约漂移」，更糟的是抽奖会被误报成**中奖**（假成功）。
 *   同一轮还实测到：token 无效时 task/getTaskSignInfo 仍回 resultCode:0、accumulateCount:0
 *   （相当于「一个没签过的新用户」）—— 所以**签到是否生效不能只看 resultCode:0**。
 *   本脚本因此对签到做**回读复核**：task/sign 返回成功后回读 getTaskSignInfo，
 *   直到 signToday===true 才算成功（首读即 true 立即结束，上限 6 次 × 2500ms ≈ 12.5s）。
 *   ⚠️ 窗口为什么是 6 次而不是 3 次：.trellis/spec/qinglong/error-handling.md 的「快照要轮询读」
 *      记录了实测 —— 服务端计数器延迟不是固定值，3 次 × 2~3s（≈8s）不够，曾把成功误报成失败；
 *      该 spec 的落地值就是 6 次尝试 / 5 次等待（≈10~15s）。两个值可用环境变量覆盖。
 *   回读 N 次仍为 false → 判「疑似空转」并置失败，**不冒充成功**；
 *   回读请求自身失败 → 保留接口返回的成功 + 一条 ⚠️ 提示，不无依据地判失败。
 *   ⚠️ 上述回读策略尚未在真号上验证（手上没有可长期复用的真凭证），属待验证项。
 *
 * 凭证存活探针（拿到 token 之后、任何写请求之前；design §4 步骤 0）
 *   为什么不能用 getTaskSignInfo 判死活：2026-11-25 实测，死凭证下它回
 *   resultCode:0 / signToday:false / accumulateCount:0（= 一个没签过的新用户），两者完全同形。
 *   能判死的只有 task/sign（写接口，不能拿来探）与 lottery/residueLotteryCount（只读）。
 *   所以每个账号在**任何写请求之前**先发一次只读的 residueLotteryCount 当探针：
 *     内层 resultCode === -516（或顶层 code:"40"）→ token 不被接受 → 零写请求中止、不落 signDone；
 *     data 是标量 → 凭证可用 → 继续；
 *     探针**网络失败** → 不判死（网络问题不是凭证问题），告警后继续走签到流程。
 *   ⚠️ 探针只发一次、结果**不复用**给签到后的正式次数查询（见 probeCredential 注释）。
 *
 * 已实测（2026-11-25，证据见上述 research 文档）
 *   · 失败一律 HTTP 200 + body 里的业务码，判活只能看业务码
 *   · task/sign 用不存在的 taskId 探测 → {"resultCode":-1118,"msg":"任务不存在"}
 *   · lottery/lottery 缺 channelNo → HTTP 400「【channelNo】must not be null;」
 *   · lottery/lottery 传不存在的 activityId → {"code":"-61003","msg":"错误的活动信息，非抽奖活动！"}
 *   · 第 1 日 2GB 是签到直发，签完即在卡包（用户确认），不需要领券接口
 *   · lottery/* 的外层 code:"200"+success:true 不是成功 ── 真实业务码在 data.resultCode；
 *     凭证无效时三个 lottery 接口与 currentLottery 均返回 data.resultCode:-516；
 *     phone 无效时 task/getTaskSignInfo 仍回 resultCode:0（signToday:false / accumulateCount:0）。
 *   · 页面登录后带出来的 phone 头（36 字符）对任意出口 IP 有效（本机 curl 实测成功）；
 *     ticket 重放立即回 code:"40006"；token 每次登录轮换、≤33 分钟就死。
 *   · mint 两个通道的拒绝码：旧 213245 / 新 110001（见上文「mint 为什么降级成兜底」）。
 *   · 未实测：task/sign 成功与重复签到的响应形状、抽到券的成功响应形状
 *     → 重复签到码**不猜**：只有服务端 msg 明说「已签到」才按幂等处理，其余未知码一律 fail-closed；
 *       券名从 prizeName / awardName / skuName 依次降级取，都没有就提示去 App 卡包核对。
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const LOG_PREFIX = '[sanri]';
const TASK_TITLE = '中国移动幸运三日签';

const ORIGIN = 'https://dev.coc.10086.cn';
const API_PREFIX = `${ORIGIN}/coc3/coc3-market-activity/cmpp-manage`;
// 现签第二步：用 autoLogin 的会话换活动侧 token（研究文档 §8.1，实测）
const LOGIN_URL = `${ORIGIN}/coc3/gr/login/ssoRights/userLoginV2`;
const LOGIN_PATH = '/coc3/gr/login/ssoRights/userLoginV2';
// ticketType / businessType 是活动维度参数（实测固定值），其余字段传空串
const LOGIN_TICKET_TYPE = 11;
const LOGIN_BUSINESS_TYPE = 'RIGHTS_MARKET';
// pageKey（26xysrqtybld）只是入口，脚本不依赖它；万一拒绝服务再改 SANRI_REFERER
const DEFAULT_REFERER = `${ORIGIN}/coc3/canvas/rightsmarket-h5-canvas/online/26xysrqtybld?channelCode=P00000112150&pageRecorded=true`;

const DEFAULT_TASK_ID = 3157;
const DEFAULT_CHANNEL_NO = 'P00000112150';

// 抽奖活动表（research/sanri-contract.md 第五节）。gateDays 只用于**文案**（说明门槛），
// 是否可抽只认 residueLotteryCount —— 服务端才是权威，别用本地门槛替代它。
const DEFAULT_ACTIVITIES = [
  { id: 17788, label: '第2日抽奖', gateDays: 2 },
  { id: 17789, label: '第3日抽奖', gateDays: 3 },
  { id: 17790, label: '每满3天抽奖', gateDays: 3 },
];

// App 内 H5 的 UA（实测服务端不强校验，保持一致便于排障）
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Mobile/15E148/wkwebview leadeon/12.5.8/CMCCIT';

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRY_MS = 3000;
const DEFAULT_GAP_MS = 1200;

// ---- 凭证来源 ①②：SANRI_PHONE（直接给的 token）与 Surge HTTP API（自动捡页面里的 phone 头）----
const ORIGIN_HOST = 'dev.coc.10086.cn';    // 只有这个 host 上的 phone 头才是本活动凭证
const SURGE_RECENT_PATH = '/v1/requests/recent';
const SURGE_SESSIONS_PATH = '/v1/capture/sessions';
const SURGE_SESSION_REQUESTS_PATH = '/v1/capture/sessions/requests';
// 会话查询的 URL 子串过滤（实测 Surge 支持 filter 参数：filter=dev.coc.10086.cn 只回活动请求）
const SURGE_SESSION_FILTER = ORIGIN_HOST;
const SURGE_SESSION_PAGE_LIMIT = 100;      // 实测上限 500，够用就行
// token 形态实测 36 字符（形如 T8QI…0524）；这里只做「不像空串/不像整段 cookie」的粗校验，
// 不写死长度：上游哪天改长度不该让脚本立刻失效。
const MIN_TOKEN_LEN = 16;
const DEFAULT_TOKEN_MAX_AGE_MIN = 25;      // Surge token 的有效期上限（分钟）

// ---- App 网关「现签」（client.app.coc.10086.cn / autoLogin）--------------------------------
// 与 zgyd/czrhd.js / qwhd.js 完全同一套（本仓库单脚本自包含，不 require 别的脚本）：
// autoLogin 不校验 cookie 里的 JSESSIONID（随机 UUID 也行），靠请求体里的 cellNum（App 内 RSA
// 加密的手机号）+ 网关签名识别用户，返回一张全新会话。
const MINT_URL = 'https://client.app.coc.10086.cn/biz-orange/LN/uamonekeylogin/autoLogin';
const MINT_PATH = '/biz-orange/LN/uamonekeylogin/autoLogin';
const MINT_KEY_REQ = Buffer.from('tVkdaRWRY0ZkV1Vr', 'utf8');
const MINT_KEY_RESP = Buffer.from('RYV0hCV1lV25KYVJ', 'utf8');
const MINT_IV = Buffer.from('VjFSQ1ZtVkQxRTlQ', 'utf8');
const MINT_TOK_KEY = Buffer.from('bAIgvwAuA4tbDr9d', 'utf8');
const MINT_TOK_IV = Buffer.from('9791027341711819', 'utf8');
const MINT_UA = 'ChinaMobile/12.5.7 (iPhone; iOS 27.0.1; Scale/3.00)';

// 风控纪律（与 czrhd / qwhd 一致，服务端额度共享）：autoLogin 等于一次「App 一键登录」
// 两次现签的最小间隔（秒）。czrhd/qwhd 用 600s，那是因为它们一天跑两次、且失败会立刻重试；
// 本脚本 cron 是每天一次，10 分钟只会挡住「手动补跑」，没有任何防风控收益。
// 2026-11-28 实测踩过：一次失败后 3 分钟手动重跑，被这条挡成「正常跳过」，失败原因被静默吃掉。
const MINT_MIN_INTERVAL_SEC = 120;
const MINT_MAX_PER_DAY = 3;        // 每天最多 3 次
const MINT_RISK_SILENCE_SEC = {
  '233031': 600, // 同号 1 分钟内重复现签
  '214100': 7200, // 请求疑似存在风险
  '214103': 86400, // 登录过于频繁（需人脸识别，可能连带封 App）
  '213245': 7200, // 一键登录旧通道已关闭（不是风控，但我们也不该每 10 分钟去打一次）
  '110001': 3600, // 运营商网络/设备绑定 —— 换网络后可能恢复，所以只静默 1 小时
};
// 现签通道被服务端关掉/被运营商绑定的两个码（2026-11-25 实测，研究文档 §8.8–8.9）。
// 它们**不是**用户的 mint 模板过期：重抓模板一点用都没有，所以单独分类，文案不得出现
// 「已失效 / 重新登录」，否则会把「通道关闭」灌进失效提醒 Bot（logging-and-notify.md）。
const MINT_CLOSED_CODES = new Set(['213245']);   // 一键登录旧通道已关闭
const MINT_NETWORK_CODES = new Set(['110001']);  // 运营商网络绑定：必须在手机蜂窝网络下由 App 完成
// 签到后回读复核的窗口（见文件头「回读复核」段）：6 次尝试 = 1 次首读 + 5 次等待 ≈ 12.5s。
// 依据 error-handling.md「快照要轮询读」的实测：3 次 × 2~3s（≈8s）不够，会造出假阴性告警。
const SIGN_VERIFY_ATTEMPTS = 6;
const SIGN_VERIFY_GAP_MS = 2500;

// 业务码分类的判据（来源与日期写在 research 文档里，改文案前先核对）
const CODE_TASK_OK = '0';                 // task/* 的 resultCode
const CODE_TASK_GONE = '-1118';           // 任务不存在（taskId 过期）
const CODE_LOTTERY_OK = '200';            // lottery/* 的 code（**字符串**）
const CODE_CREDENTIAL = '40';             // 顶层凭证类业务码（code:"40" 无权限）
// 风控评分拒绝（2026-11-28 实测抽奖）：
//   {"code":-1,"message":"访问过于频繁,请稍后再试",
//    "data":{"explain":"SCORE_REFUSE","level":5,"risk":true,"url":".../risk-verify/#/orderFail?..."}}
// 判定用 explain==='SCORE_REFUSE' 或 risk===true，**不要**只看 code:-1 或 message 文案
// （code:-1 是通用失败码，message 是给人看的自由文本，都可能变）。
const CODE_RISK = '-1';
const RISK_EXPLAIN = 'SCORE_REFUSE';
// 风控冷却：命中后静默这么久（秒），期间不再发任何业务请求。
// 抽奖次数不会被消耗（实测抽完 residue 仍是 1），所以冷却后重试是安全的。
const RISK_COOLDOWN_SEC = 2 * 3600;
const CODE_ACTIVITY_GONE = '-61003';      // 错误的活动信息，非抽奖活动
// 二次嵌套的业务码（2026-11-25 实测，本轮 dry-run 新发现）：lottery/* 的 data 里**又套了一层**
//   {"code":"200","msg":"操作成功","data":{"resultCode":-516,"msg":"用户未登录或登录已失效","data":null},"success":true}
// → 外层 code:"200" + success:true **不代表成功**，真正的业务码在内层 resultCode。
//   不处理这一层的话，凭证失效会被误报成「契约漂移」，更糟的是抽奖会被误报成中奖（假成功）。
const CODE_NESTED_CREDENTIAL = '-516';    // 用户未登录或登录已失效
const CONTRACT_400_RE = /must not be null|must not be empty/i;

// 失败分类
const KIND = {
  OK: 'ok',
  TASK_GONE: 'task_gone',
  ACTIVITY_GONE: 'activity_gone',
  CREDENTIAL: 'credential',
  CONTRACT: 'contract',
  NETWORK: 'network',
  UNKNOWN: 'unknown',
  LOGIN: 'login_failed',   // 现签第二步被拒（code 非 "0"，如 40006 ticket 过期）
  THROTTLED: 'throttled',  // 现签被本地纪律/风控码静默 —— 正常跳过，不进通知
  MINT_CLOSED: 'mint_closed',   // 现签旧通道已被服务端关闭（213245）—— 重抓模板没用
  MINT_NETWORK: 'mint_network', // 现签被运营商网络/设备绑定拒（110001）—— 容器出口做不到
  NO_CREDENTIAL: 'no_credential', // 三条来源全都没拿到 token —— 零业务请求
  RISK: 'risk_refused',   // 风控评分拒绝（SCORE_REFUSE）—— 不是凭证问题，冷却后重试
};

// 需要脱敏的键（日志与通知都要过一遍）。
// 改造后本活动没有长期凭证：`phone` 头的值（login 返回的 token）只在内存里活一轮，
// 但它仍然算凭证 —— 进日志/通知一律脱敏。token/refreshToken 也列上，兜住直接 stringify 响应的场景。
const SECRET_KEYS = ['phone', 'token', 'refreshToken', 'SANRI_ACCOUNTS', 'cookie', 'authorization'];
// 已知凭证原文（parseAccounts 时登记），用于兜住「没有 key 名」的裸值泄漏
const SECRET_VALUES = new Set();
// 下游 Node-RED 靠这些词分流「需要人工处理」的失效提醒 Bot（表由 Node-RED 侧维护）
const ALERT_KEYWORDS = '已失效,无效用户,失效,cookie失效,ck失效,登录失效,账号失效,账号过期,重新登录,发生异常,invalid,expired';
const NOTICE_PLACEHOLDER = '⚠️ 已省略一段疑似凭证类文本（原文见面板日志）';

const RERUN_CMD = 'node zgyd/sanri.js';

class SanriError extends Error {
  constructor(type, message, extra = {}) {
    super(message);
    this.name = 'SanriError';
    this.type = type; // config_missing | network | schema_changed | business
    Object.assign(this, extra);
  }
}

/* ------------------------------------------------------------------ */
/* 日志 & 脱敏                                                          */
/* ------------------------------------------------------------------ */

// 凭证（phone 头的 token；长度实测 39）按「前 4 + … + 后 4」脱敏：
// 与 czrhd 的「前 12 + *** + 后 4」不同，因为这个值比 cookie 短很多，留 12 位太多。
function maskSecret(secret) {
  const s = String(secret ?? '');
  if (s.length < 9) return '***';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function registerSecret(value) {
  const s = String(value ?? '');
  if (s.length >= 9) SECRET_VALUES.add(s);
}

// 本地脱敏手机号（与登录返回的 mobileMask 同形：前 3 + **** + 后 4）。
// 只用于「登录前」的显示名与日志；登录后一律用服务端返回的 mobileMask（更权威）。
function maskPhone(tel) {
  const s = String(tel ?? '');
  if (/^1\d{10}$/.test(s)) return `${s.slice(0, 3)}****${s.slice(-4)}`;
  return s ? maskSecret(s) : '';
}

// 账号指纹：mint 模板（xk + reqBody.cellNum）+ tel 的哈希。
// 用途只有两个：① 多账号保序去重的键 ② 状态文件里 fp → mobileMask 的索引键。
// 不用明文 tel 当键：状态文件落在 /ql/data/config，不落明文手机号。
function fingerprint(mint, tel) {
  const material = [str(tel), str(mint && mint.xk), str(mint && mint.reqBody && mint.reqBody.cellNum)].join('|');
  return crypto.createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 12);
}

// 两种形态都脱：① 带 key 名（phone= / phone: / "phone":"…"）② 裸值（登记过的原文）
// ① 的值字符类**只收 ASCII**：凭证都是 ASCII；若不排掉中文，像
//   `SANRI_ACCOUNTS = 该模板；多个账号用 …` 这样的中文说明会被当成「值」吃掉、被脱敏
//   （实测踩到过：通知里「多个账号」被替换成「…个账号」）。
function redact(text) {
  let out = String(text ?? '');
  for (const key of SECRET_KEYS) {
    out = out.replace(new RegExp(`(["']?${key}["']?\\s*[:=]\\s*["']?)([^"',;\\s{}\u0080-\uFFFF]{8,})`, 'gi'),
      (_m, head, val) => `${head}${maskSecret(val)}`);
  }
  for (const val of SECRET_VALUES) {
    if (out.includes(val)) out = out.split(val).join(maskSecret(val));
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

// 外部文本（服务端 msg、券名、时间串等）进通知前逐处收口。
// ⚠️ 自有的凭证类文案（「凭证已失效，请重新登录…」）**不要**过这个函数，
//    否则会被替换成占位符，该进失效 Bot 的通知就再也看不出是凭证问题。
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

// 「不知道」≠ 0：Number(null) === 0 / Number('') === 0，直接用 Number 会把缺失的累计天数
// 说成「0 天」，还会让「签到后 +1」变成 1（本文件 describeGate 处专门警告过这个反模式）。
// 所有来自服务端的数值字段都过这个函数，缺失一律回 null。
function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// 服务端按北京时间判定日期/天数；固定 +8 偏移自行换算，避开容器时区
function nowShanghai(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600 * 1000);
}

function todayShanghai(date = new Date()) {
  const t = nowShanghai(date);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

function hhmmShanghai(date = new Date()) {
  const t = nowShanghai(date);
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}

function isoShanghai(date = new Date()) {
  return `${nowShanghai(date).toISOString().slice(0, 19)}+08:00`;
}

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

const MSG_MISSING = [
  '❌ 未配置任何凭证来源（SANRI_PHONE / SANRI_SURGE_URL+SANRI_SURGE_KEY / SANRI_ACCOUNTS）',
  '业务请求只需要一个头 phone: <token>（实测 36 字符）。三种给法，按优先级：',
  '  ① SANRI_PHONE：手机打开「中国移动」App → 幸运三日签活动页（刷新一次）→ 抓包工具里找',
  '     dev.coc.10086.cn 的 POST 请求 → 复制请求头 phone 的值 → 填成 SANRI_PHONE=<token>',
  '  ② SANRI_SURGE_URL + SANRI_SURGE_KEY：让脚本自己从 Surge 抓包记录里捡这个 phone 头（免手工）',
  '  ③ SANRI_ACCOUNTS：放 autoLogin 明文模板走现签兜底（2026-11-25 实测该通道已被服务端关闭，',
  '     正常情况下不必配；抓法见文件头注释）',
  '多账号：多个 token / 多份模板用 & 或换行分隔（保序去重）。',
].join('\n');

// 三条来源全部拿不到 token 时的可执行下一步（**零业务请求**退出）。
// ⚠️ 这段文案自身**不得**命中失效分流关键词（`已失效|重新登录|发生异常|invalid|expired`）：
//    它说的是「本次没拿到凭证」，不是「你的凭证失效了」——用户要做的动作是「去开页面 / 填变量」。
const NO_CRED_HOWTO = [
  ' 1. 手机打开「中国移动」App → 幸运三日签活动页（刷新一次，页面登录后才会带 phone 头）',
  ' 2. 抓包工具里找 dev.coc.10086.cn 的 POST 请求，复制请求头 phone 的值（实测 36 字符，形如 T8QI…0524）',
  ' 3. 填进 SANRI_PHONE，或配置 SANRI_SURGE_URL + SANRI_SURGE_KEY 让脚本自动提取',
  ' 4. ⚠️ token 寿命约 30 分钟（实测 ≤33 分钟），拿到后请尽快运行本脚本；cron 每 10 分钟扫一次 Surge',
];

// 凭证类失败时的可执行步骤。改造后「重抓一个手机号密文」已经不可能修好问题 ——
// 要重抓的是 mint 模板（autoLogin 请求体）。
const REFETCH_HOWTO = [
  '   👉 重新抓取 mint 模板（现签用；抓包关键词写 10086.cn）:',
  '      1. 抓包工具里找 POST https://client.app.coc.10086.cn/biz-orange/LN/uamonekeylogin/autoLogin',
  '      2. 抓不到就先在 App 里退出登录，再点「本机号码一键登录」（冷启动也会发）',
  '      3. 「复制为 cURL」→ 取请求体整个 JSON，原样整段替换 SANRI_ACCOUNTS 里的 mint 字段',
  '      4. ⚠️ mint 里的字段一个字都不要改（它会被原样 AES 加密回传，服务端校验签名与结构）',
];

function splitAccounts(raw) {
  return String(raw || '').split(/[\n&]/).map((s) => s.trim()).filter(Boolean);
}

// SANRI_PHONE：用户直接给的 token 列表。
//   形式一（推荐）：<token>                  —— 多账号用 & 或换行分隔
//   形式二（可选）：{"phone":"<token>","tel":"13800138000"}   —— tel 只用于显示名/状态键
// 为什么允许 JSON：token 本身没有可读身份，没有 tel 就只能把账号叫成 phone1 / phone2；
// 给了 tel 就能在通知里看到 138****8000（服务端 mobileMask 只在 mint 通道里才有）。
// 返回 [{ token, tel }]；**保序去重**（同一个 token 只跑一次）。
function parseTokens(raw) {
  const tokens = [];
  const problems = [];
  const seen = new Set();

  splitAccounts(raw).forEach((text, index) => {
    let token = text;
    let tel = '';
    if (/^[\[{]/.test(text)) {
      let obj;
      try {
        obj = JSON.parse(text);
      } catch (e) {
        problems.push(`SANRI_PHONE[${index}] 不是合法 JSON: ${e.message}`);
        return;
      }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        problems.push(`SANRI_PHONE[${index}] 必须是 {"phone":"<token>","tel":"13800138000"} 形式的对象`);
        return;
      }
      token = str(obj.phone, str(obj.token));
      tel = str(obj.tel);
    }
    const value = String(token || '').trim();
    // 粗校验：凭证是单段 ASCII，不含空白；太短的肯定不是（实测 36 字符）
    if (!value || /\s/.test(value) || value.length < MIN_TOKEN_LEN) {
      problems.push(`SANRI_PHONE[${index}] 不是一个合法的 phone token（需单段、无空白、≥${MIN_TOKEN_LEN} 字符）`);
      return;
    }
    if (seen.has(value)) return; // 保序去重
    seen.add(value);
    tokens.push({ token: value, tel });
  });

  return { tokens, problems };
}

// 账号表 = SANRI_ACCOUNTS 里的 mint 模板 + SANRI_PHONE 里的 token，**按顺序配对**：
//   第 n 个 mint 账号用第 n 个 token；多出来的 token 自成账号（没有 mint，只能走 ①② 两级）。
// 为什么按顺序而不是按手机号：token 本身不含手机号，SANRI_PHONE 也不强制带 tel；
// 顺序配对是唯一不靠猜的配对方式（用户把两份变量按同一顺序填即可，脚本会在启动日志里打印配对结果）。
// mint 账号的 fp 来自 mint 模板（稳定）；token-only 账号的 fp 来自“位置”（token 会过期轮换，
// 拿 token 当身份会让每天的状态键都不一样，幂等就废了）。
function parseAccounts(raw, tokenList = []) {
  const accounts = [];
  const problems = [];
  const seen = new Set();
  const tokens = Array.isArray(tokenList) ? tokenList : [];

  splitAccounts(raw).forEach((text, index) => {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      problems.push(`SANRI_ACCOUNTS[${index}] 不是合法 JSON: ${e.message}`);
      return;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      problems.push(`SANRI_ACCOUNTS[${index}] 必须是一个 JSON 对象（形如 {"tel":"…","mint":{…}}）`);
      return;
    }
    const mint = obj.mint && typeof obj.mint === 'object' && !Array.isArray(obj.mint) ? obj.mint : null;
    const missing = [];
    // mint 现在是**可选**的（有 SANRI_PHONE / Surge 就不需要现签）；但一旦写了 mint，
    // 就必须是完整的：缺 xk / cellNum 的模板只能发出必败的请求。
    if (mint) {
      if (!str(mint.xk)) missing.push('mint.xk');
      if (!mint.reqBody || !str(mint.reqBody.cellNum)) missing.push('mint.reqBody.cellNum');
    }
    if (missing.length) {
      problems.push(`SANRI_ACCOUNTS[${index}] 缺少字段: ${missing.join(', ')}` +
        '（mint 就是 autoLogin 的请求体明文，原样贴进来即可）');
      return;
    }
    const tel = str(obj.tel);
    const fp = mint ? fingerprint(mint, tel) : `tel:${tel || `#${index + 1}`}`;
    if (seen.has(fp)) return; // 保序去重（同一份 mint 模板 / 同一个 tel = 同一账号）
    seen.add(fp);
    const fixed = tokens[index];
    if (fixed) registerSecret(fixed.token);
    accounts.push({
      tel,
      fp,
      mint,
      // 登录前的显示名：有 tel 就用本地脱敏号，没 tel 就退回指纹前 6 位（不是凭证，可读性为辅）
      masked: maskPhone(tel) || `fp:${fp.slice(0, 6)}`,
      // ① SANRI_PHONE 给的 token（空串 = 本账号没配，往下走 Surge / mint）
      fixedToken: fixed ? fixed.token : '',
      phone: '', // ← 业务请求头的值，**只能**由 resolveCredential 写入，见那里的注释
    });
  });

  // 多出来的 token：自成账号（没有 mint → fixedToken='' 时无路可走，所以直接跳过而不是建空账号）
  for (let i = accounts.length; i < tokens.length; i += 1) {
    const item = tokens[i];
    const fp = `token:#${i + 1}`; // 按位置取号：token 会轮换，不能拿它当身份（否则幂等失效）
    if (seen.has(fp)) continue;
    seen.add(fp);
    registerSecret(item.token);
    accounts.push({
      tel: item.tel,
      fp,
      mint: null,
      // 没有 tel 时显示成 phone1 / phone2 —— 描述的是「第几个 token」，不是凭证本身
      masked: maskPhone(item.tel) || `phone${i + 1}`,
      fixedToken: item.token,
      phone: '',
    });
  }

  return { accounts, problems };
}

// ② Surge 的**占位账号**：Surge 的 token 是运行时从抓包里捡的，不由 parseAccounts 产出；
// 而 resolveCredential 的 ② 分支在 runAccount 里执行 —— 没有 account 对象就永远走不到它。
// 只配 Surge（不配 SANRI_PHONE / SANRI_ACCOUNTS）时曾经直接判「未配置」，② 成了死代码。
// 占位账号**不含任何凭证**（fixedToken='' / mint=null），它只做一件事：把流程送进 ②。
// 捡到 token 就用；捡不到就落到 KIND.NO_CREDENTIAL（4 步可执行指引），**不会**回头报「未配置」。
const SURGE_PLACEHOLDER_FP = 'surge';
const SURGE_PLACEHOLDER_MASKED = 'Surge自动获取';

function surgePlaceholderAccount() {
  return {
    tel: '',
    // 状态键用固定指纹：Surge 侧只能捡到「当前设备当前账号」，多账号请显式配 SANRI_PHONE
    fp: SURGE_PLACEHOLDER_FP,
    mint: null,
    // ② 拿不到 mobileMask（token 里没有手机号），显示名先用占位；拿到 token 后仍是它
    masked: SURGE_PLACEHOLDER_MASKED,
    fixedToken: '',
    phone: '',
  };
}

// 三个来源里**有没有配任何一个**（纯函数，便于自检直接断言）。
// Surge 也算一个来源：它的凭证是运行时捡的，但「配了 URL」本身就说明用户已经配好了来源，
// 所以纯 Surge 模式**不是**「未配置」—— 它要的是去捡 token，而不是去填变量。
function hasAnyCredentialSource(cfg) {
  return Boolean(cfg && (cfg.accountsRaw || cfg.phoneRaw || cfg.surgeUrl));
}

// 解析 + 补齐账号表。返回 { accounts, tokens, problems, placeholder }。
// · problems 非空且 accounts 为空 → 用户的变量写错了（如 SANRI_PHONE 给了短值），
//   照旧报「解析失败」，**不**静默降级到 Surge（否则「我明明配了」会变成更难排查的谜题）
// · accounts 为空 + 只配了 Surge → 造 1 个占位账号（Surge 侧本来就只有一把「当前账号」的凭证）
function buildAccountList(cfg) {
  const { tokens, problems: tokenProblems } = parseTokens(cfg.phoneRaw);
  const { accounts, problems: accountProblems } = parseAccounts(cfg.accountsRaw, tokens);
  const problems = [...tokenProblems, ...accountProblems];
  let placeholder = false;
  if (!accounts.length && !problems.length && cfg.surgeUrl) {
    accounts.push(surgePlaceholderAccount());
    placeholder = true;
  }
  return { accounts, tokens, problems, placeholder };
}

function parseActivities(raw) {
  const fallback = DEFAULT_ACTIVITIES.map((a) => ({ ...a }));
  if (!str(raw)) return { activities: fallback, problem: '' };
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch (e) {
    return { activities: [], problem: `SANRI_ACTIVITIES 不是合法 JSON: ${e.message}` };
  }
  if (!Array.isArray(arr) || arr.length === 0) {
    return { activities: [], problem: 'SANRI_ACTIVITIES 必须是非空 JSON 数组，形如 [{"id":17788,"label":"第2日抽奖","gateDays":2}]' };
  }
  const out = [];
  for (let i = 0; i < arr.length; i += 1) {
    const it = arr[i];
    const id = num(it && it.id, NaN);
    if (!Number.isFinite(id) || id <= 0) {
      return { activities: [], problem: `SANRI_ACTIVITIES[${i}] 缺少合法的 id` };
    }
    out.push({ id, label: str(it && it.label, `活动${id}`), gateDays: num(it && it.gateDays, 0) });
  }
  return { activities: out, problem: '' };
}

function readConfig(env = process.env, argv = process.argv.slice(2)) {
  const stateDir = fs.existsSync('/ql/data/config') ? '/ql/data/config' : __dirname;
  const { activities, problem } = parseActivities(str(env.SANRI_ACTIVITIES));
  const dryRun = str(env.SANRI_DRY_RUN, '0') === '1' || argv.includes('--dry-run');
  return {
    accountsRaw: str(env.SANRI_ACCOUNTS),
    phoneRaw: str(env.SANRI_PHONE),
    surgeUrl: String(str(env.SANRI_SURGE_URL)).replace(/\/+$/, ''),
    surgeKey: str(env.SANRI_SURGE_KEY),  // 可空：Surge 没设 Key 时就不发这个头
    surgeSession: String(str(env.SANRI_SURGE_SESSION, 'auto')).trim() || 'auto',
    tokenMaxAgeMin: Math.max(1, num(env.SANRI_TOKEN_MAX_AGE_MIN, DEFAULT_TOKEN_MAX_AGE_MIN)),
    activities,
    activityProblem: problem,
    taskId: num(env.SANRI_TASK_ID, DEFAULT_TASK_ID),
    channelNo: str(env.SANRI_CHANNEL_NO, DEFAULT_CHANNEL_NO),
    referer: str(env.SANRI_REFERER, DEFAULT_REFERER),
    timeoutMs: Math.max(3000, num(env.SANRI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)),
    retryMs: Math.max(500, num(env.SANRI_RETRY_MS, DEFAULT_RETRY_MS)),
    drawRetry: Math.max(0, num(env.SANRI_DRAW_RETRY, 0)),
    gapMs: Math.max(0, num(env.SANRI_GAP_MS, DEFAULT_GAP_MS)),
    verifyAttempts: Math.max(1, num(env.SANRI_VERIFY_ATTEMPTS, SIGN_VERIFY_ATTEMPTS)),
    verifyMs: Math.max(0, num(env.SANRI_VERIFY_MS, SIGN_VERIFY_GAP_MS)),
    dryRun,
    push: str(env.SANRI_PUSH, '1') !== '0',
    stateFile: str(env.SANRI_STATE_FILE, path.join(stateDir, '.sanri-state.json')),
    state: emptyState(),
  };
}

/* ------------------------------------------------------------------ */
/* 状态文件                                                            */
/*   键用**登录返回的 mobileMask**（如 183****1323；不落明文手机号、不落 token）*/
/*   每个账号条目的字段：                                                */
/*     date              这份状态属于哪天（签到日）—— 跨日重置的主键      */
/*     signDone          当天是否已签到                                  */
/*     accumulateCount   服务端返回的当月累计签到天数（不知道就是 null）  */
/*     drawsDate          这批 draws 结论属于哪天（跨日必须不复用）        */
/*     draws              逐活动的 { settlement, count, prize, detail }   */
/*     credFails          连续凭证类失败的**天数**（不是次数）            */
/*     lastCredFailDate   上次计入 credFails 的日期（同一天重跑不重复计） */
/*   top-level:                                                         */
/*     masks             fp → 账号显示名索引（取到凭证前用它定位状态条目，见 readMask）*/
/*     mint              fp → 凭证获取的薄记：现签计数/静默（600s 间隔、每天 3 次、风控码）*/
/*                       以及 noticeDate（「未拿到凭证 / 凭证类失败」每天只推一次的节流标记）*/
/*     notice            全局通知节流（configMissingDate：未配置告警每天只推一次）       */
/*   用途：① 当天已完成的幂等 ② 连续失败天数 ③ 凭证获取频率/静默/通知节流        */
/* ------------------------------------------------------------------ */

function emptyState() {
  return { version: 1, accounts: {}, masks: {}, mint: {}, notice: {} };
}

function loadState(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!obj || typeof obj !== 'object') return emptyState();
    return {
      version: 1,
      accounts: obj.accounts && typeof obj.accounts === 'object' ? obj.accounts : {},
      masks: obj.masks && typeof obj.masks === 'object' ? obj.masks : {},
      mint: obj.mint && typeof obj.mint === 'object' ? obj.mint : {},
      notice: obj.notice && typeof obj.notice === 'object' ? obj.notice : {},
    };
  } catch {
    return emptyState();
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

function accountState(state, masked) {
  if (!state.accounts || typeof state.accounts !== 'object') state.accounts = {};
  const cur = state.accounts[masked];
  if (!cur || typeof cur !== 'object') state.accounts[masked] = {};
  return state.accounts[masked];
}

// 只读取已有条目（不产生副作用），供只读模式使用
function readAccountState(state, masked) {
  const cur = state && state.accounts && state.accounts[masked];
  return cur && typeof cur === 'object' ? cur : {};
}

// fp → mobileMask 索引。状态文件的键是 mobileMask（可读、稳定），但**登录前**只知道账号的
// fp（mint 模板指纹）。没有这份索引，「当天已完成 → 零请求」就无从判断，于是每次运行都要
// 花一次现签额度（每天只有 3 次！）。索引只用于定位条目，不承担任何成败判定。
function readMask(state, fp) {
  const masks = state && state.masks && typeof state.masks === 'object' ? state.masks : null;
  return str(masks ? masks[fp] : '');
}

function writeMask(state, fp, mask) {
  if (!state || !fp || !mask) return;
  if (!state.masks || typeof state.masks !== 'object') state.masks = {};
  state.masks[fp] = mask;
}

// 现签计数/静默（按账号指纹存，跨日不重置 count 会在第二天自然失效 —— 见 nextMintSlot）
function mintState(state, fp) {
  if (!state.mint || typeof state.mint !== 'object') state.mint = {};
  const cur = state.mint[fp];
  if (!cur || typeof cur !== 'object') state.mint[fp] = {};
  return state.mint[fp];
}

// 当天完成的判据：日期对 + 已签到 + 每个抽奖活动都有**结论**（error 不算结论 → 重跑要补抽）
// `drawsDate` 也必须对：旧版本状态文件（本字段并不存在）或跨日未重置时，
// 它的 draws 不能当成今天的结论（否则 isDayComplete 会直接零请求跳过，比 runDraws
// 里那条守卫漏得更彻底）。
function isDayComplete(entry, today, activities) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.date !== today || entry.drawsDate !== today || !entry.signDone) return false;
  const draws = entry.draws && typeof entry.draws === 'object' ? entry.draws : {};
  return activities.every((a) => {
    const d = draws[String(a.id)];
    return Boolean(d) && d.settlement !== 'error';
  });
}

/* ------------------------------------------------------------------ */
/* HTTP 层                                                             */
/* ------------------------------------------------------------------ */

// 唯一凭证：phone 头。它的值 = 本次现签（login）返回的 data.token，**不是**配置里的任何值。
// account.phone 只在 loginCredential 成功时被写入；配置对象里永远是空串。
// **不要**加 coc-aurora / coc-en-version / Authorization / cookie
// —— research 文档实测这些都不参与本活动的鉴权（COC3 画布的 WASM 指纹是「软」的）。
function baseHeaders(account, cfg) {
  return {
    phone: account.phone,
    'content-type': 'application/json;charset=utf-8',
    accept: '*/*',
    origin: ORIGIN,
    referer: cfg.referer,
    'user-agent': UA,
  };
}

// 现签第二步（userLoginV2）没有 phone 头可带 —— 它的输入就是 ticket。
function loginHeaders(cfg) {
  return {
    'content-type': 'application/json;charset=utf-8',
    accept: '*/*',
    origin: ORIGIN,
    referer: cfg.referer,
    'user-agent': UA,
  };
}

// 默认网络层。自检会把 transport 换成必抛桩，保证 --selfcheck 全程离线。
// secureOptions：client.app.coc.10086.cn 要求 legacy renegotiation，Node 的 fetch(undici) 无法配置，
// 会报 ERR_SSL_UNSAFE_LEGACY_RENEGOTIATION_DISABLED，所以现签这一步走 node:https 并显式放开。
// GET 也走这里（Surge HTTP API 要用）：不传 body 就不带 content-length，method 默认 POST。
// ⚠️ Surge 的 API 是**明文 http**（http://<ip>:6171），不能统一用 node:https：
//    https.request 拒约 http: 协议，会直接报 “Protocol "http:" not supported”。所以按协议选模块。
function httpRequest({ method = 'POST', url, headers, body, timeoutMs, secureOptions }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : Buffer.from(String(body), 'utf8');
    const isHttp = /^http:\/\//i.test(String(url || ''));
    const mod = isHttp ? http : https;
    const req = mod.request(url, {
      method,
      ...(!isHttp && secureOptions ? { secureOptions } : {}),
      headers: payload ? { ...headers, 'content-length': payload.length } : { ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        httpStatus: res.statusCode,
        setCookies: res.headers['set-cookie'] || [],
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`超时 ${timeoutMs}ms`)));
    req.on('error', (e) => reject(new SanriError(KIND.NETWORK, `请求失败: ${e.code || e.message}`)));
    req.end(payload || undefined);
  });
}

let transport = httpRequest; // 依赖注入点：自检里被替换成抛错桩

function parseJsonLoose(text) {
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

// 返回 { httpStatus, text, json }：**不抛**业务失败，交给 classify* 分类。
// 业务失败一律 HTTP 200 + body 里的业务码，所以不能拿 HTTP 状态码判活。
// extra 用于把 path（自检/日志用）等元信息带进 transport。
async function rawPost(url, headers, bodyObj, cfg, deps = {}, extra = {}) {
  const request = deps.request || transport;
  const body = JSON.stringify(bodyObj);
  const res = await request({ url, ...extra, headers, body, timeoutMs: cfg.timeoutMs });
  const text = String((res && res.text) || '');
  return { httpStatus: num(res && res.httpStatus, 0), text, json: parseJsonLoose(text) };
}

async function apiPost(account, cfg, apiPath, bodyObj, deps = {}) {
  const url = `${API_PREFIX}/${apiPath}`;
  return rawPost(url, baseHeaders(account, cfg), bodyObj, cfg, deps, { path: apiPath });
}

// 网络失败重试：**只对网络层**重试。业务码失败一律不重试（可能已经消耗次数）。
async function postWithRetry(account, cfg, apiPath, bodyObj, retries, deps = {}) {
  const wait = deps.sleep || sleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await apiPost(account, cfg, apiPath, bodyObj, deps);
    } catch (e) {
      const isNetwork = e instanceof SanriError && e.type === KIND.NETWORK;
      if (!isNetwork || attempt >= retries) throw e;
      logWarn(`⚠️ ${apiPath} 网络失败（${e.message}），${Math.round(cfg.retryMs / 1000)}s 后第 ${attempt + 1} 次重试`);
      await wait(cfg.retryMs);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 凭证来源 ①②：SANRI_PHONE / Surge HTTP API                           */
/* ------------------------------------------------------------------ */

// Surge 抓包记录：URL / startDate（秒，可带小数）。部分记录缺 startDate，
// 退到 setupCompletedDate / completedDate；都没有就返回 null（无法判有效期）。
function surgeRecordUrl(rec) {
  return str(rec && rec.URL, str(rec && rec.url));
}

function surgeRecordAt(rec) {
  for (const key of ['startDate', 'setupCompletedDate', 'completedDate']) {
    const v = num(rec ? rec[key] : NaN, NaN);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

// 只认 dev.coc.10086.cn（别的 host 上的 phone 头不是本活动凭证）
function isActivityUrl(url) {
  const raw = String(url || '');
  if (!raw) return false;
  try {
    return new URL(raw).hostname === ORIGIN_HOST;
  } catch {
    return raw.includes(`${ORIGIN_HOST}/`);
  }
}

// 从 Surge 的 requestHeader 里取某个头的值。实测形态（原始头块，以请求行开头）:
//   "POST /coc3/... HTTP/2\r\n:authority: dev.coc.10086.cn\r\n...\r\nphone: T8QI...\r\n"
// 值里出现空白就不采用（凭证是单段 ASCII，带空白的不是我们要的那种头）。
function headerValue(rawHeader, name) {
  const want = String(name || '').toLowerCase();
  if (!want) return '';
  for (const line of String(rawHeader || '').split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    if (line.slice(0, idx).trim().toLowerCase() !== want) continue;
    const value = line.slice(idx + 1).trim();
    return /\s/.test(value) ? '' : value;
  }
  return '';
}

// 纯函数：一批 Surge 记录 → 可用的 token（按抓取时间从新到旧；[] = 没有）。
// 三条判据（research 文档 §8.9）：
//   ① 只认 dev.coc.10086.cn 域的请求；
//   ② 必须有 requestHeader 里的 phone 头；
//   ③ startDate 必须在 maxAgeMin 分钟内 —— 过期的 token 用了只会得到 -516，白跑一轮。
//   ⚠️ 没有 startDate 的记录**不采用**：无法判有效期时不赌，宁可退回 mint / 报未拿到凭证。
// 抽成纯函数是为了能被离线自检直接断言（有效期/域名/token 去重三组夹具）。
function pickPhoneTokens(records, opts = {}) {
  const nowSec = num(opts.nowSec, Math.floor(Date.now() / 1000));
  const maxAgeSec = Math.max(60, num(opts.maxAgeMin, DEFAULT_TOKEN_MAX_AGE_MIN) * 60);
  const list = Array.isArray(records) ? records : [];
  const found = new Map(); // token → at（同一条 token 只留最新那次）
  let skippedStale = 0;
  let skippedNoTime = 0;
  for (const rec of list) {
    if (!isActivityUrl(surgeRecordUrl(rec))) continue;
    const token = headerValue(rec && rec.requestHeader, 'phone');
    if (!token || token.length < MIN_TOKEN_LEN) continue;
    const at = surgeRecordAt(rec);
    if (at === null) { skippedNoTime += 1; continue; }
    if (nowSec - at > maxAgeSec) { skippedStale += 1; continue; }
    const prev = found.get(token);
    if (prev === undefined || at > prev) found.set(token, at);
  }
  const tokens = [...found.entries()].sort((a, b) => b[1] - a[1]).map(([token, at]) => ({ token, at }));
  return { tokens, skippedStale, skippedNoTime };
}

// Surge HTTP API 用 GET + X-Key（实测响应 {requests:[…]} / {sessions:[…]}）
// Key 留空就不发那个头（本地 Surge 可能根本没设 Key）。
function surgeHeaders(cfg) {
  const headers = { accept: 'application/json' };
  if (cfg.surgeKey) headers['x-key'] = cfg.surgeKey;
  return headers;
}

async function surgeGet(cfg, apiPath, query, deps = {}) {
  const request = deps.request || transport;
  const url = `${cfg.surgeUrl}${apiPath}${query ? `?${query}` : ''}`;
  const res = await request({
    method: 'GET', url, path: apiPath, headers: surgeHeaders(cfg),
    timeoutMs: cfg.timeoutMs,
  });
  const httpStatus = num(res && res.httpStatus, 0);
  if (httpStatus && (httpStatus < 200 || httpStatus >= 300)) {
    // 非 2xx 也算失败：Surge 参数不合法时回 400 + JSON，直接把 400 当成「空结果」
    // 会让「抓包里没有 token」这种误导致告警失去可诊断性。
    throw new SanriError(KIND.NETWORK, `Surge ${apiPath} 返回 HTTP ${httpStatus}`);
  }
  const payload = parseJsonLoose(String((res && res.text) || ''));
  if (!payload) {
    throw new SanriError(KIND.NETWORK, `Surge ${apiPath} 返回的不是 JSON（HTTP ${httpStatus}）`);
  }
  return payload;
}

// recent：Surge 只留最近 50 条（实测），所以它只能当第一道便宜的过滤器
async function surgeRecentRecords(cfg, deps) {
  const payload = await surgeGet(cfg, SURGE_RECENT_PATH, '', deps);
  const list = payload.requests || payload.records || [];
  return Array.isArray(list) ? list : [];
}

// 会话：recent 只有 50 条，App 自己的轮询流量几十秒就能把活动请求挤出环形缓冲，
// 所以再查一次抓包会话 —— 实测 /v1/capture/sessions/requests 支持 filter=<URL 子串>，
// filter=dev.coc.10086.cn 时只回活动请求（十几条），不用翻页。
async function surgeSessionRecords(cfg, deps) {
  const session = str(cfg.surgeSession, 'auto'); // 没配就当 auto（不能把 undefined 当会话名）
  if (session === 'off') return [];
  let name = session;
  if (session === 'auto') {
    const payload = await surgeGet(cfg, SURGE_SESSIONS_PATH, '', deps);
    const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
    const pick = sessions.find((s) => s && s.active) || sessions[0]; // 会话列表实测按新到旧
    name = str(pick && pick.name);
    if (!name) return [];
  }
  const query = `name=${encodeURIComponent(name)}&offset=0&limit=${SURGE_SESSION_PAGE_LIMIT}`
    + `&filter=${encodeURIComponent(SURGE_SESSION_FILTER)}`;
  const payload = await surgeGet(cfg, SURGE_SESSION_REQUESTS_PATH, query, deps);
  const list = Array.isArray(payload.requests) ? payload.requests : [];
  if (list.length) log(`Surge 会话 ${name} 命中 ${list.length} 条 ${ORIGIN_HOST} 请求`);
  return list;
}

// 每次运行只取一次（结果缓存在 cfg 上，多账号共用）。
// **绝不抛**：Surge 是外部依赖，挂了要告警 + 降级到下一种来源，不能把账号判成失败。
async function surgeTokens(cfg, deps = {}) {
  if (cfg.surgeCache) return cfg.surgeCache;
  const result = { tokens: [], reason: '' };
  cfg.surgeCache = result;
  if (!cfg.surgeUrl) { result.reason = '未配置'; return result; }

  const opts = { nowSec: Math.floor(Date.now() / 1000), maxAgeMin: cfg.tokenMaxAgeMin };
  const errors = [];
  try {
    const fromRecent = pickPhoneTokens(await surgeRecentRecords(cfg, deps), opts);
    if (fromRecent.tokens.length) {
      result.tokens = fromRecent.tokens.map((t) => t.token);
      log(`✅ Surge recent 里捡到 ${result.tokens.length} 个 ${cfg.tokenMaxAgeMin} 分钟内的 phone 头`);
      return result;
    }
  } catch (e) {
    errors.push(`recent: ${e && e.message ? e.message : e}`);
  }
  try {
    const fromSession = pickPhoneTokens(await surgeSessionRecords(cfg, deps), opts);
    if (fromSession.tokens.length) {
      result.tokens = fromSession.tokens.map((t) => t.token);
      log(`✅ Surge 会话里捡到 ${result.tokens.length} 个 ${cfg.tokenMaxAgeMin} 分钟内的 phone 头`);
      return result;
    }
    if (!errors.length) {
      result.reason = fromSession.skippedStale
        ? `有 ${fromSession.skippedStale} 个 phone 头但都超过 ${cfg.tokenMaxAgeMin} 分钟`
        : (fromSession.skippedNoTime ? `有 ${fromSession.skippedNoTime} 个 phone 头但没有时间戳` : '抓包里没有可用的 phone 头');
    }
  } catch (e) {
    errors.push(`session: ${e && e.message ? e.message : e}`);
  }
  if (errors.length) result.reason = errors.join('；');
  if (result.reason) logWarn(`⚠️ Surge 未取到可用 token（${result.reason}），降级到下一种凭证来源`);
  return result;
}

/* ------------------------------------------------------------------ */
/* 凭证来源链：SANRI_PHONE（①）→ Surge（②）→ mint（③，兜底）            */
/* ------------------------------------------------------------------ */

// 三条来源按顺序试，前一条拿到 token 就停。返回值 { ok, source, token, mobileMask, cls }；
// **只有 mint 通道**会把业务失败当返回值，另两条要么拿到 token、要么抛（Surge 永不抛）。
// ⚠️ ① 一旦配了就不再降级：显式配置被悄悄换成别的凭证，比直接失败更难排查。
async function resolveCredential(account, slot, cfg, deps = {}) {
  // ① SANRI_PHONE
  if (account.fixedToken) {
    registerSecret(account.fixedToken);
    log(`✅ 凭证来源 ① SANRI_PHONE（token=${maskSecret(account.fixedToken)}）`);
    return { ok: true, source: 'phone', token: account.fixedToken, mobileMask: '', cls: null };
  }
  // ② Surge：按账号顺序分配捡到的 token（第 n 个账号用第 n 个）
  if (cfg.surgeUrl) {
    const surge = await surgeTokens(cfg, deps);
    const token = str(surge.tokens[num(slot, 0)]);
    if (token) {
      registerSecret(token);
      log(`✅ 凭证来源 ② Surge（token=${maskSecret(token)}）`);
      return { ok: true, source: 'surge', token, mobileMask: '', cls: null };
    }
  }
  // ③ mint 兜底
  if (!account.mint) {
    // token-only 账号（只有 SANRI_PHONE 来的 token）没有 mint 可兜底
    throw new SanriError(KIND.NO_CREDENTIAL, '三条凭证来源都没拿到 token（本账号也没有 mint 模板可兜底）');
  }
  const { cls } = await loginCredential(account, cfg, deps);
  if (!cls.ok) return { ok: false, source: 'mint', token: '', mobileMask: '', cls };
  return { ok: true, source: 'mint', token: cls.token, mobileMask: cls.mobileMask, cls };
}

/* ------------------------------------------------------------------ */
/* 现签：autoLogin（①）→ userLoginV2（②）→ phone 头的 token（③）       */
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

// userLoginV2 的 ticket 实测就是 ① 那条 Set-Cookie 的**完整原值**（含 Comment/Path/HTTPOnly/Secure）。
// 不要重排/精简：qwhd 那边实测过「只留 JSESSIONID+UID+ticketID」会被判登录态过期。
function buildAppTicket(setCookieValue) {
  const raw = String(setCookieValue || '').trim();
  if (!/(?:^|;\s*)JSESSIONID=/.test(raw)) return null;
  return raw;
}

// ① autoLogin：现签一张 App 网关会话，返回 userLoginV2 需要的 ticket（完整 Set-Cookie 串）
// 风控纪律跟 czrhd 一模一样（两次间隔 600s / 每天 3 次 / 风控码静默），静默状态落状态文件。
async function mintAppTicket(account, cfg, deps = {}) {
  const tpl = account.mint;
  if (!tpl || !tpl.xk) {
    throw new SanriError(KIND.CONTRACT, '缺少 autoLogin 模板（account.mint.xk）');
  }
  const ms = mintState(cfg.state, account.fp);
  const now = Math.floor(Date.now() / 1000);
  if (num(ms.blockedUntil, 0) > now) {
    const left = Math.ceil((num(ms.blockedUntil, 0) - now) / 60);
    throw new SanriError(KIND.THROTTLED, `现签风控静默中（code=${str(ms.blockedCode, '?')}，剩余 ${left} 分钟），本轮跳过`);
  }
  if (now - num(ms.lastTs, 0) < MINT_MIN_INTERVAL_SEC) {
    // 把上一次的真实失败原因带出来：否则「失败 → 被节流跳过 → 原因永远看不到」，
    // 用户只能看到一句「不足 N 分钟」，完全无从排查（2026-11-28 踩过）。
    const lastErr = str(ms.lastError, '');
    throw new SanriError(KIND.THROTTLED,
      `距上次现签不足 ${Math.round(MINT_MIN_INTERVAL_SEC / 60)} 分钟，本轮跳过`
      + (lastErr ? `；上次现签失败原因：${lastErr}` : ''));
  }
  // 每天最多 3 次：按**北京日**判断是否需要把计数归零（用 UTC 日界会变成北京时间 08:00
  // 前后各刷 3 次 = 6 次，正好踩在风控线上）
  const beijingDay = (sec) => Math.floor((sec + 8 * 3600) / 86400);
  if (beijingDay(num(ms.lastTs, 0)) !== beijingDay(now)) ms.count = 0;
  if (num(ms.count, 0) >= MINT_MAX_PER_DAY) {
    throw new SanriError(KIND.THROTTLED, `今日现签已达上限 ${MINT_MAX_PER_DAY} 次，本轮跳过`);
  }

  const ts = String(Date.now());
  const nonce = String(Math.floor(10000000 + Math.random() * 90000000));
  // 明文必须是用户贴进来的那份模板（原样序列化）：xs 签的就是这串
  const plain = JSON.stringify(tpl);
  const body = aesEncryptB64(MINT_KEY_REQ, MINT_IV, plain);
  const xToken = aesEncryptB64(MINT_TOK_KEY, MINT_TOK_IV, `${tpl.xk}_${MINT_PATH}_${ts}_${nonce}`);
  const xs = md5hex(`${MINT_URL}_${plain}_Leadeon/SecurityOrganization`);
  const jsid = crypto.randomUUID();
  const xSign = md5hex(`${xToken}_${ts}_${nonce}_${jsid}`);

  // ⚠️ 先不动 ms.lastTs / ms.count：只有**真正拿到 ticket** 才算消耗一次现签额度。
  // 2026-11-28 实测踩过：旧实现在发请求**之前**就落盘 lastTs+count，于是
  //   · 一次网络失败/风控失败会白等 10 分钟（下一轮直接被「不足 10 分钟」挡掉）
  //   · 每天 3 次的额度也会被失败请求吃掉
  //   · 更糟的是「失败 → 下一轮被静默跳过 → 真正的失败原因永远看不到」
  const prevCount = num(ms.count, 0);

  const request = deps.request || transport;
  const res = await request({
    url: MINT_URL,
    path: MINT_PATH,
    timeoutMs: cfg.timeoutMs,
    secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
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
    const j = JSON.parse(aesDecryptB64(MINT_KEY_RESP, MINT_IV, String(res.text || '').replace(/[^A-Za-z0-9+/=]/g, '')));
    retCode = String(j.retCode || '');
    retDesc = String(j.retDesc || '');
  } catch { /* 解不开就只靠 Set-Cookie 判断 */ }

  if (retCode && retCode !== '000000') {
    const silence = MINT_RISK_SILENCE_SEC[retCode];
    if (silence) {
      ms.blockedUntil = now + silence;
      ms.blockedCode = retCode;
    }
    // 两个「通道性」拒绝码单独归类（2026-11-25 实测，研究文档 §8.8–8.9）：
    // 它们不是用户的模板过期，重抓模板没用，所以不能送进「凭证失效」通道
    // （那会让人去做无效动作）。
    // ⚠️ 这两个分支**故意不带 retDesc**：服务端原文里可能出现「请重新登录」字样，
    //    进了通知就会把「通道关闭」灌进失效提醒 Bot（logging-and-notify.md）。
    if (MINT_CLOSED_CODES.has(retCode)) {
      throw new SanriError(KIND.MINT_CLOSED, `一键登录旧通道已被服务端关闭（retCode=${retCode}）`);
    }
    if (MINT_NETWORK_CODES.has(retCode)) {
      throw new SanriError(KIND.MINT_NETWORK,
        `运营商侧拒绝（retCode=${retCode}）：一键登录需在手机蜂窝网络下由 App 完成，容器出口做不到`);
    }
    // 风控码只进面板日志：静默类直接归 THROTTLED（跳过、不进通知）
    throw new SanriError(silence ? KIND.THROTTLED : KIND.CREDENTIAL,
      `现签失败 retCode=${retCode}(${retDesc})`);
  }

  const setCookie = (res.setCookies || []).find((x) => /JSESSIONID=/.test(x)) || '';
  const ticket = buildAppTicket(setCookie);
  if (!ticket) {
    throw new SanriError(KIND.CREDENTIAL,
      `现签没拿到 JSESSIONID（HTTP ${num(res.httpStatus, 0)}${retCode ? `, retCode=${retCode}` : ''}）`);
  }
  const ticketId = (/(?:^|;\s*)ticketID=([^;]+)/.exec(setCookie) || [])[1] || '?';
  // 只有走到这里才算真的消耗了一次现签额度（见上面 prevLastTs 的注释）
  ms.lastTs = now;
  ms.count = prevCount + 1;
  log(`✅ 现签网关会话成功（ticketID=${ticketId}，今日第 ${ms.count} 次）`);
  return ticket;
}

// ② userLoginV2：用 ticket 换活动侧 token。
// 响应契约（研究文档 §8.1，实测）：{"code":"0","message":"成功!","data":{token,refreshToken,mobileMask,…}}
// 失败实测：重放旧 ticket → {"code":"40006","message":"用户信息已过期，请重新访问"}
function loginBody(ticket) {
  return {
    ticket,
    ticketType: LOGIN_TICKET_TYPE,
    businessType: LOGIN_BUSINESS_TYPE,
    wxoaType: '',
    m1: '',
    m2: '',
    s1: '',
    s2: '',
    from: '',
    // ⚠️ jsid 必填且**与 ticket 同值**（2026-11-26 实测）：
    //   只传 ticket 不传 jsid → 服务端认不出会话 → code=40006 用户信息已过期；
    //   补上 jsid 后同一个 ticket 立即 code=0 成功。抓包样本（会话 2026-11-25-125054 #12331）
    //   两个字段逐字相同，别自作聪明地只留一个。
    jsid: ticket,
  };
}

function classifyLogin(res) {
  const httpStatus = num(res && res.httpStatus, 0);
  const empty = { ok: false, kind: KIND.UNKNOWN, code: '', msg: '', token: '', mobileMask: '', refreshToken: '' };
  if (httpStatus === 401 || httpStatus === 403) {
    return { ...empty, kind: KIND.CREDENTIAL, code: String(httpStatus), msg: `HTTP ${httpStatus}` };
  }
  let payload = res && res.json && typeof res.json === 'object' ? res.json : null;
  if (!payload) payload = parseJsonLoose(String((res && res.text) || '')); // 允许只给 text 的调用方
  if (!payload) {
    return { ...empty, code: String(httpStatus), msg: `登录响应不是 JSON（HTTP ${httpStatus}）` };
  }
  const code = payload.code === undefined || payload.code === null ? '' : String(payload.code);
  const msg = str(payload.message, str(payload.msg));
  const data = payload.data && typeof payload.data === 'object' ? payload.data : null;
  if (code !== '0') {
    // 40006 等：ticket 不可用。ticket 是当次现签的，所以这是「现签链路失败」而不是
    // 「用户的凭证过期」—— 但处置都是人工重抓 mint，所以归凭证通道（见 runAccount）。
    return { ...empty, kind: KIND.LOGIN, code, msg };
  }
  const token = data ? str(data.token) : '';
  if (!token) {
    // code:"0" 但没有 token = 契约漂移。**绝不能**拿空 token 继续发业务请求：
    // 那会变成匿名请求，上游可能回「今天没签过」→ 骗用户已签。
    return { ...empty, kind: KIND.CONTRACT, code, msg: msg || 'code:"0" 但 data.token 缺失' };
  }
  return {
    ok: true,
    kind: KIND.OK,
    code,
    msg,
    token,
    mobileMask: str(data.mobileMask),
    refreshToken: str(data.refreshToken), // 用不上（只给页面续命用），不落盘
  };
}

function describeLogin(cls) {
  if (!cls) return '无结论';
  const bits = [`code=${cls.code || '空'}`];
  if (cls.msg) bits.push(`msg=${cls.msg}`);
  return bits.join(' ');
}

// 现签全链路：① + ②。返回 { cls, res, ticket }；不抛业务错（网络错照旧抛）。
async function loginCredential(account, cfg, deps = {}) {
  const ticket = await mintAppTicket(account, cfg, deps);
  const res = await rawPost(LOGIN_URL, loginHeaders(cfg), loginBody(ticket), cfg, deps, { path: LOGIN_PATH });
  const cls = classifyLogin(res);
  if (cls.ok) {
    registerSecret(cls.token);
    log(`✅ 现签换取 token 成功（mobileMask=${cls.mobileMask || '未返回'}，token=${maskSecret(cls.token)}）`);
  }
  return { cls, res, ticket };
}

/* ------------------------------------------------------------------ */
/* 响应分类（两个外壳分开解析）                                          */
/* ------------------------------------------------------------------ */

// family: 'task' 看 resultCode（数字），'lottery' 看 code（字符串 "200"）
// 风控载荷判定：只认结构字段，不认文案。
// 实测形态见 CODE_RISK 的注释；这里对 task/* 与 lottery/* 两种外壳都适用
// （风控信息都在 data 里，不在顶层）。
function isRiskPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const data = payload.data;
  if (!data || typeof data !== 'object') return false;
  if (data.risk === true) return true;
  return str(data.explain).toUpperCase() === RISK_EXPLAIN;
}

function classify(family, res) {
  const httpStatus = num(res && res.httpStatus, 0);
  const text = String((res && res.text) || '');
  let payload = res && res.json && typeof res.json === 'object' ? res.json : null;
  if (!payload && text) payload = parseJsonLoose(text); // 允许只给 text 的调用方（自检/未来换适配器）
  const msg = payload ? str(payload.msg, str(payload.message)) : '';
  const done = (kind, code, extra = '') => ({ ok: kind === KIND.OK, kind, code: String(code ?? ''), msg: msg || extra });

  // ① body 契约漂移：实测 POST 缺 channelNo → HTTP 400「【channelNo】must not be null;」
  if (httpStatus === 400 && CONTRACT_400_RE.test(text)) {
    return done(KIND.CONTRACT, '400', '请求体缺必需字段(HTTP 400)，脚本需要更新');
  }
  // ② HTTP 401/403 归凭证类（其余 4xx 不归，避免 Invalid URL 之类被误判成凭证失效）
  if (httpStatus === 401 || httpStatus === 403) {
    return done(KIND.CREDENTIAL, httpStatus, `HTTP ${httpStatus}`);
  }
  if (!payload) {
    return done(KIND.UNKNOWN, httpStatus, `响应不是 JSON（HTTP ${httpStatus}，长度 ${text.length}）`);
  }

  // ③ 凭证类：实测 lottery 外壳用 code:"40"（无权限）；同一网关也可能把 code 回给 task 外壳，
  //    所以先不分外壳统一认一次（resultCode 外壳里没有 code 字段，不会误伤）
  const genericCode = payload.code === undefined || payload.code === null ? '' : String(payload.code);
  if (genericCode === CODE_CREDENTIAL) return done(KIND.CREDENTIAL, genericCode);

  // ③.5 风控评分拒绝（2026-11-28 实测抽奖 lottery/lottery）：
  //   {"code":-1,"message":"访问过于频繁,请稍后再试",
  //    "data":{"explain":"SCORE_REFUSE","level":5,"risk":true,"url":".../risk-verify/#/orderFail?..."}}
  // 判据只用结构字段 explain / risk，**不看** code 或 message 文案（两者都可能变）。
  // 归 RISK 而不是 UNKNOWN：它既不是凭证问题（不该进失效 Bot）、也不是契约漂移（不该报「脚本要更新」），
  // 而是「短时间请求太多」—— 冷却后重试即可。抽奖次数不会被消耗（实测 residue 不变）。
  if (isRiskPayload(payload)) {
    const lv = payload.data && typeof payload.data === 'object' ? payload.data.level : '';
    return done(KIND.RISK, genericCode || 'risk', `风控评分拒绝（${RISK_EXPLAIN}${lv !== '' ? `, level=${lv}` : ''}）`);
  }

  if (family === 'task') {
    const code = payload.resultCode === undefined || payload.resultCode === null ? '' : String(payload.resultCode);
    if (code === CODE_TASK_OK) return nestedVerdict(payload.data) || done(KIND.OK, code);
    if (code === CODE_TASK_GONE) return done(KIND.TASK_GONE, code, '任务不存在');
    if (code === CODE_CREDENTIAL) return done(KIND.CREDENTIAL, code);
    // task/* 的顶层也会出现 -516：写接口 task/sign 对死凭证实测回
    //   {"resultCode":-516,"msg":"用户未登录或登录已失效","data":null}
    // （research/sanri-contract.md §4.1）。不接这一条会把凭证失效误归成「未知业务码」，
    // 于是既不进凭证通道、也不累加 credFails —— 真号上就变成每天一条看不懂的「签到失败」。
    if (code === CODE_NESTED_CREDENTIAL) return done(KIND.CREDENTIAL, code);
    return done(KIND.UNKNOWN, code, '未知业务码');
  }

  const code = payload.code === undefined || payload.code === null ? '' : String(payload.code);
  if (code === CODE_LOTTERY_OK) {
    // ⚠️ 外层 code:"200" + success:true 不是成功判据，真正的是 data.resultCode（实测）
    return nestedVerdict(payload.data) || done(KIND.OK, code);
  }
  if (code === CODE_CREDENTIAL) return done(KIND.CREDENTIAL, code);
  if (code === CODE_ACTIVITY_GONE) return done(KIND.ACTIVITY_GONE, code, '错误的活动信息，非抽奖活动');
  return done(KIND.UNKNOWN, code, '未知业务码');
}

// 二次嵌套：把 data 里的那一层业务结果拆出来（详见 CODE_NESTED_CREDENTIAL 处的注释）
function unwrapNested(data) {
  if (data && typeof data === 'object' && !Array.isArray(data) && 'resultCode' in data) {
    const rc = data.resultCode;
    return {
      nested: true,
      resultCode: rc === undefined || rc === null ? null : String(rc),
      msg: str(data.msg),
      data: data.data,
    };
  }
  return { nested: false, resultCode: null, msg: '', data };
}

// 内层业务码 → 失败分类；内层没报错时返回 null
function nestedVerdict(data) {
  const n = unwrapNested(data);
  if (!n.nested || n.resultCode === null || n.resultCode === '0') return null;
  const code = n.resultCode;
  const msg = n.msg || '未知业务码';
  if (code === CODE_NESTED_CREDENTIAL) return { ok: false, kind: KIND.CREDENTIAL, code, msg };
  if (code === CODE_TASK_GONE) return { ok: false, kind: KIND.TASK_GONE, code, msg };
  if (code === CODE_ACTIVITY_GONE) return { ok: false, kind: KIND.ACTIVITY_GONE, code, msg };
  // 未知内层业务码一律 fail-closed（宁可不猜成功）
  return { ok: false, kind: KIND.UNKNOWN, code, msg };
}

function describeClass(cls) {
  if (!cls) return '无结论';
  const bits = [`kind=${cls.kind}`];
  if (cls.code) bits.push(`code=${cls.code}`);
  if (cls.msg) bits.push(`msg=${cls.msg}`);
  return bits.join(' ');
}

/* ------------------------------------------------------------------ */
/* 业务字段解析                                                        */
/* ------------------------------------------------------------------ */

// signToday 三态：true / false / null（null = 不知道，绝不当成「没有」）
// accumulateCount 同理：缺失 / null 一律回 null，**不能**回 0（Number(null) === 0），
// 否则「签到后 +1」会把不知道的天数变成「1 天」写进通知（S5 的那类假数字）。
function parseSignInfo(payload) {
  const data = payload && typeof payload === 'object' ? payload.data : null;
  if (!data || typeof data !== 'object') {
    return { signToday: null, accumulateCount: null, skuList: [] };
  }
  return {
    signToday: data.signToday === true ? true : data.signToday === false ? false : null,
    accumulateCount: numOrNull(data.accumulateCount),
    skuList: Array.isArray(data.skuList) ? data.skuList : [],
  };
}

// 签到档位奖励：skuList 里 signDays 等于「累计天数」的那项。
// 返回 { name, signDays } 而不是只返回名字 —— 因为文案必须区分档位：
//   契约 §5.1：第 1 天奖励**可直接到账**（2GB 流量日包自动进卡包），
//   **第 2 天起**的档位奖励/资格需要用户到「兑换专区」抽取，签到本身不发奖。
//   只拿到名字时无法区分这两种，只好把档位一起返回。
function findSignAward(skuList, accumulateCount) {
  if (!Array.isArray(skuList)) return null;
  const acc = numOrNull(accumulateCount);
  if (acc === null) return null;
  const hit = skuList.find((s) => s && num(s.signDays, -1) === acc);
  if (!hit) return null;
  const name = str(hit.awardName, str(hit.skuName));
  if (!name) return null;
  return { name, signDays: acc };
}

// 券名：成功响应形状**未实测**，三个字段都认（research 文档第七节未知项 3）
function pickPrizeName(data) {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.prize === 'string' && data.prize) return data.prize;
  const scopes = [data, data.prize, data.award, data.prizeInfo, data.sku]
    .filter((v) => v && typeof v === 'object');
  for (const scope of scopes) {
    for (const key of ['prizeName', 'awardName', 'skuName']) {
      const v = str(scope[key]);
      if (v) return v;
    }
  }
  return null;
}

// gateDays 只用于文案：说清「为什么没次数」
function describeGate(activity, accumulateCount) {
  const need = num(activity && activity.gateDays, 0);
  if (need <= 0) return '';
  // ⚠️ Number(null) === 0，会把「不知道天数」说成「当前 0 天」，这里必须显式排掉
  const acc = accumulateCount === null || accumulateCount === undefined || accumulateCount === ''
    ? NaN : Number(accumulateCount);
  if (!Number.isFinite(acc)) return `需累计 ${need} 天`;
  return acc >= need
    ? `已满足累计 ${need} 天`
    : `需累计 ${need} 天，当前 ${accumulateCount} 天`;
}

/* ------------------------------------------------------------------ */
/* 业务动作                                                            */
/* ------------------------------------------------------------------ */

async function getSignInfo(account, cfg, deps = {}) {
  const res = await postWithRetry(account, cfg, 'task/getTaskSignInfo',
    { taskId: cfg.taskId, needLimit: 0 }, 0, deps);
  return { res, cls: classify('task', res), info: parseSignInfo(res.json) };
}

// 凭证存活探针（design §4 步骤 0）——必须在**任何写请求之前**。
// 为什么不能用 getTaskSignInfo 判死活：2026-11-25 实测，死凭证下它回
//   resultCode:0 / signToday:false / accumulateCount:0（= 一个没签过的新用户），两者完全同形。
// 能判死的只有 task/sign（写接口，不能拿来探）与 lottery/residueLotteryCount（只读），
// 后者把 -516 放在**二次嵌套**的 data.resultCode 里（见 CODE_NESTED_CREDENTIAL），故必须走
// classify('lottery') + unwrapNested，不能只看外层 code:"200" + success:true。
//
// 探针活动取 cfg.activities[0]（不写死 17790）的理由：SANRI_ACTIVITIES 可被环境变量整体替换
//   （换批次时 activityId 会变），取用户自己列表的第一项就不会发明一个可能不存在的 activityId。
//
// 探针**只发一次**（不随活动表发三次），且结果**不复用**给 runDraws 的正式查询 ——
//   所以「探针 1 次 + 每个活动各 1 次」是**有意为之**的 1+N 次只读请求：探针跑在签到之前，
//   而「签到后抽奖次数何时到账」未实测（research 第七节未知项 4），拿签到前的次数当正式结论
//   会把「签完刚拿到的那一次机会」误判成 0 次。
async function probeCredential(account, cfg, deps = {}) {
  const activity = Array.isArray(cfg.activities) ? cfg.activities[0] : null;
  const activityId = num(activity && activity.id, DEFAULT_ACTIVITIES[0].id);
  const res = await postWithRetry(account, cfg, 'lottery/residueLotteryCount', { activityId }, 0, deps);
  const cls = classify('lottery', res);
  // 剥掉二次嵌套后才能拿到「次数」本身；拿不到就报「未知」，绝不降级成 0 次
  const raw = cls.ok ? unwrapNested(res.json ? res.json.data : undefined).data : undefined;
  const scalar = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '');
  return { activityId, res, cls, raw, scalar };
}

// 签到后的**服务端复核**：写接口不能拿 resultCode:0 当成功（本仓库的硬规矩：写接口空转）。
// 实测根据：token 无效时 getTaskSignInfo 仍然回 resultCode:0 / accumulateCount:0，
// 也就是说服务端可能对无效身份返回「一切正常但什么也没做」。因此签完必须回读 signToday。
// 轮询有界（首读就为 true 立即结束），不得无限等 —— 会挂死 cron。
// 次数/间隔取自 cfg（SANRI_VERIFY_ATTEMPTS / SANRI_VERIFY_MS），默认 6 次 × 2500ms。
async function verifySigned(account, cfg, deps = {}) {
  const wait = deps.sleep || sleep;
  const attempts = Math.max(1, num(cfg.verifyAttempts, SIGN_VERIFY_ATTEMPTS));
  const gapMs = Math.max(0, num(cfg.verifyMs, SIGN_VERIFY_GAP_MS));
  for (let i = 0; i < attempts; i += 1) {
    if (i > 0) await wait(gapMs);
    let again;
    try {
      again = await getSignInfo(account, cfg, deps);
    } catch (e) {
      return { status: 'unknown', detail: `复核请求失败: ${e && e.message ? e.message : e}` };
    }
    if (!again.cls.ok) return { status: 'unknown', detail: describeFailure(again.cls) };
    if (again.info.signToday === true) {
      return { status: 'confirmed', info: again.info, tries: i + 1 };
    }
  }
  return { status: 'unconfirmed', tries: attempts };
}

// 签到：成功 / 疑似幂等 / 失败
async function doSign(account, cfg, deps = {}) {
  if (cfg.dryRun) return { kind: 'dry_run', cls: null };
  const res = await postWithRetry(account, cfg, 'task/sign', { taskId: cfg.taskId }, 0, deps);
  const cls = classify('task', res);
  if (cls.ok) return { kind: 'ok', cls };
  // 幂等码**未实测**：只有服务端 msg 明确说「已签到」才按幂等处理，其余未知码一律 fail-closed
  if (cls.kind === KIND.UNKNOWN && /已经?签到|重复签|今日.{0,4}签过/.test(cls.msg)) {
    return { kind: 'already', cls, uncertain: true };
  }
  return { kind: cls.kind, cls };
}

async function runDraws(account, cfg, entry, today, deps = {}) {
  const out = [];
  // 「不知道」≠ 0 天：numOrNull 而不是 Number(...)，否则 null 会变成 0 天写进文案
  const accumulate = numOrNull(entry.accumulateCountAfter);

  for (const activity of cfg.activities) {
    const id = String(activity.id);
    const label = str(activity.label, `活动${id}`);
    const item = {
      id, label, settlement: 'error', count: null, prize: null, detail: '', invalid: false, skipped: false,
    };

    // 今天已抽过（settlement=won）→ 跳过，不重复消耗。两个守卫分别拦不同残料：
    //   ① entry.drawsDate === today —— 这条结论属于**今天**吗？（B1：没有它，昨天或旧版本
    //      状态文件里的 won 会永远拦住今天的抽奖）
    //   ② prev.settlement === 'won' —— 只有「真的已经抽过」才跳过。
    //      ⚠️ settlement='empty'（次数 0）**故意不复用**：签到会新增资格，签到前查到的
    //      「0 次」如果当成今天的结论，签到成功后的重跑就不会再查 → 漏掉刚到手的那次机会。
    //      代价是重跑时多一次只读的 residueLotteryCount（不消耗次数），比漏抽便宜得多。
    const prev = entry.draws && entry.draws[id];
    if (entry.drawsDate === today && prev && prev.settlement === 'won') {
      // 只降级成一行「跳过」说明：settlement / count / prize / detail **原样保留**，
      // 否则 won 会被写成 skip、次数变成 null、detail 每次重跑多套一层括号（永不自愈）。
      item.settlement = prev.settlement;
      item.count = numOrNull(prev.count);
      item.prize = str(prev.prize) || null;
      item.detail = str(prev.detail);
      item.skipped = true;
      out.push(item);
      continue;
    }

    const residueRes = await postWithRetry(account, cfg, 'lottery/residueLotteryCount',
      { activityId: activity.id }, 0, deps);
    const residueCls = classify('lottery', residueRes);
    log(`${label} residueLotteryCount → HTTP ${residueRes.httpStatus} ${describeClass(residueCls)}`);
    if (!residueCls.ok) {
      item.detail = residueCls.kind === KIND.CREDENTIAL
        ? '查抽奖次数时凭证已失效'
        : `查抽奖次数失败（${describeFailure(residueCls)}）`;
      item.invalid = residueCls.kind === KIND.CREDENTIAL;
      out.push(item);
      // 凭证已死：剩下两个活动只会以同样方式失败，不再白打（未查的活动不落状态 → 重跑会补）
      if (item.invalid) break;
      continue;
    }

    // 先剥掉二次嵌套那层（实测 data 可能是 {resultCode,msg,data}）
    // ⚠️ 「不知道」≠「没有」：data 缺失/null/空串一律判契约异常，绝不降级成 0 次
    const rawCount = unwrapNested(residueRes.json ? residueRes.json.data : undefined).data;
    const count = (typeof rawCount === 'number' || (typeof rawCount === 'string' && rawCount.trim() !== ''))
      ? Number(rawCount) : NaN;
    if (!Number.isFinite(count)) {
      item.detail = '查抽奖次数失败：data 不是数字（接口契约可能已变，未当成 0 次处理）';
      out.push(item);
      continue;
    }
    item.count = count;

    // ⚠️ 守护：次数为 0 时**绝对不能**发 lottery/lottery（会白消耗一次机会，甚至被判异常）
    // 这条日志与「凭证探针判定失效」的日志必须一眼可分：这里带「无抽奖次数」，探针那条带「🔑 凭证探针」。
    if (count <= 0) {
      item.settlement = 'empty';
      const gate = describeGate(activity, accumulate);
      item.detail = gate ? `无抽奖次数（${gate}）` : '无抽奖次数';
      log(`${label} 无抽奖次数（${gate || '服务端返回 0 次'}）→ 不发 lottery/lottery`);
      out.push(item);
      continue;
    }

    if (cfg.dryRun) {
      item.settlement = 'skip';
      item.detail = `只读模式：有 ${count} 次抽奖机会，未发 lottery/lottery`;
      out.push(item);
      continue;
    }

    let drawRes;
    try {
      drawRes = await postWithRetry(account, cfg, 'lottery/lottery',
        { activityId: activity.id, scene: 1, channelNo: cfg.channelNo }, cfg.drawRetry, deps);
    } catch (e) {
      item.detail = `抽奖请求失败: ${e && e.message ? e.message : e}`;
      out.push(item);
      continue;
    }

    const drawCls = classify('lottery', drawRes);
    log(`${label} lottery → HTTP ${drawRes.httpStatus} ${describeClass(drawCls)}`);
    if (drawCls.ok) {
      const prize = pickPrizeName(unwrapNested(drawRes.json && drawRes.json.data).data);
      item.settlement = 'won';
      item.prize = prize;
      item.detail = prize
        ? `抽中 ${prize}（${count} 次机会已用 1 次）`
        : `抽奖成功，但响应里没有券名字段（请到 App 卡包核对；${count} 次机会已用 1 次）`;
    } else if (drawCls.kind === KIND.CREDENTIAL) {
      item.invalid = true;
      item.detail = '抽奖时凭证已失效';
      out.push(item);
      break;
    } else if (drawCls.kind === KIND.RISK) {
      // 风控评分拒绝：不是失败、不是凭证问题，冷却后重试即可。
      // 次数**不会被消耗**（实测抽完 residue 仍是 1），所以不标 invalid、不计入 problems。
      item.settlement = 'skip';
      item.detail = `风控拦截（${RISK_EXPLAIN}），本次不抽；次数保留，冷却后重试`;
      markRiskCooldown(cfg, account, today);
    } else if (drawCls.kind === KIND.CONTRACT) {
      item.detail = '抽奖请求体契约漂移（HTTP 400 缺必需字段），请更新脚本';
    } else if (drawCls.kind === KIND.ACTIVITY_GONE) {
      item.detail = `活动信息错误/非抽奖活动（code=${drawCls.code}）—— activityId 可能随批次变更，改 SANRI_ACTIVITIES`;
    } else {
      item.detail = `抽奖失败（${describeFailure(drawCls)}）`;
    }
    out.push(item);
  }

  return out;
}

function describeFailure(cls) {
  if (!cls) return '无结论';
  if (cls.kind === KIND.TASK_GONE) {
    return `任务不存在（resultCode=${cls.code}）—— taskId 可能随批次变更，改 SANRI_TASK_ID`;
  }
  if (cls.kind === KIND.CONTRACT) return '请求体契约漂移(HTTP 400 缺必需字段)，请更新脚本';
  if (cls.kind === KIND.CREDENTIAL) return `凭证类失败（code=${cls.code || 'HTTP'}）`;
  if (cls.kind === KIND.ACTIVITY_GONE) {
    return `活动信息错误/非抽奖活动（code=${cls.code}）—— activityId 可能随批次变更，改 SANRI_ACTIVITIES`;
  }
  const msg = str(cls.msg);
  return `code=${cls.code || '空'}${msg ? ` ${noticeSafe(msg)}` : ''}（未知业务码，不改判定）`;
}

// 连续凭证类失败「天数」计数（不是次数）。
// 以前的写法是每次失败都 +1，于是同一天重跑 3 次就把 credFails 变成 3，通知写「已连续 3 天」，
// 会骗用户去重抓一张本来有效的凭证。改成只有**换了一天**才 +1。
// 风控冷却记账：把 blockedUntil 写进 mint 状态，复用现签那套「静默」机制。
// 为什么复用：现签的静默本来就是「这段时间别发请求」的通用语义，再开一套字段只会增加状态面积。
function markRiskCooldown(cfg, account, today) {
  try {
    const ms = mintState(cfg.state, account.fp);
    const until = Math.floor(Date.now() / 1000) + RISK_COOLDOWN_SEC;
    if (num(ms.blockedUntil, 0) < until) {
      ms.blockedUntil = until;
      ms.blockedCode = RISK_EXPLAIN;
    }
    ms.riskDate = today;
  } catch { /* 记账失败不影响主流程 */ }
}

function bumpCredFails(entry, today) {
  if (!entry || typeof entry !== 'object') return 0;
  if (entry.lastCredFailDate === today) return num(entry.credFails, 0);
  entry.credFails = num(entry.credFails, 0) + 1;
  entry.lastCredFailDate = today;
  return entry.credFails;
}

// 跨日重置：昨天（或更早）的任何结论都不得参与今天的判定，**也不能被重新盖在今天的状态上**。
// 为什么必须有这一步：draws 以前**从不按日重置**，而 runDraws 的跳过判定只检查
// `prev.settlement !== 'error'`、没有日期守卫 —— 于是第 2 天起每个活动都命中「今日已有结论」，
// lottery/lottery 一次都不发，签到却照常成功、通知天天绿色，用户完全看不出漏了抽奖。
//
// 它与 runDraws 里的日期守卫是**两道各管一件事**的防线（不是重复）：
//   · 本函数管「状态文件里不得残留前几天的结论」—— 尤其是凭证中断（break）导致
//     部分活动本轮根本没被访问时，昨天的 won 不能被重新打上今天的 drawsDate；
//   · runDraws 的守卫管「这一条结论到底属于哪天」—— 覆盖旧版本状态文件
//     （drawsDate 不存在）与跨日后未重置的残料。
// 只按 `entry.date` 判跨日（不额外看 drawsDate）：date 是「这份状态属于哪天」的主键。
// 已知遗留（可接受）：若状态文件是旧格式（无 drawsDate）而 date 恰好已是今天，且本轮又在
// 抽奖中途凭证失效（break），未被访问到的活动会带着旧结论被重新盖上今天的 drawsDate ——
// 重跑时会跳过它们。代价只限于「升级当天 + 凭证失效」这个组合，且不会错报成功；
// 宁可保留这个残留，也不用「写盘时过滤 draws」（那会让上面两道防线变成同一道，失去交叉保）。
function resetForNewDay(entry, today) {
  if (!entry || typeof entry !== 'object') return entry;
  if (entry.date !== today) {
    entry.signDone = false;          // 昨天的签到不算今天的
    entry.draws = {};                // 昨天的抽奖结论全部作废
    entry.accumulateCountAfter = null;
  }
  return entry;
}

// 连续凭证类失败 2 天才判定「凭证链路持续失败」（来源不同，要重抓的东西也不同）
function credentialHint(entry, source = '') {
  const fails = num(entry && entry.credFails, 0);
  const what = (source === 'phone' || source === 'surge')
    ? 'SANRI_PHONE / Surge 抓到的 phone 头一直不被接受'
    : 'SANRI_ACCOUNTS 里的 mint 模板已过期';
  if (fails <= 1) return '（第 1 天失败：可能是临时风控或网络抖动，明日再跑一次即可确认）';
  return `（已连续 ${fails} 天凭证类失败：基本可以确定 ${what}，必须重新抓取）`;
}

// 凭证类失败的统一处置文案（**自有**凭证文案，不过 noticeSafe —— 它就该进失效提醒 Bot）。
// 它必须包含「重新登录」：下游 Node-RED 就靠这个词分流。
const MSG_NEED_RELOGIN = '请在中国移动 App 内重新登录后重跑；若反复出现，重抓一次 autoLogin 请求体更新 SANRI_ACCOUNTS';
// token 通道（SANRI_PHONE / Surge）的凭证类失败文案。同样必须含「已失效」「重新登录」——
// 这是真的凭证失效，该进失效提醒 Bot；但「重抓什么」跟 mint 通道完全不同。
const MSG_NEED_PHONE = 'phone 凭证已失效：请在中国移动 App 内重新登录并重新打开活动页，'
  + '把新的 phone 头填进 SANRI_PHONE（或配置 SANRI_SURGE_URL 让脚本自动提取）后重跑';

// 凭证类失败的「怎么办」按来源分支：mint 要重抓模板，token 要重抓 phone 头。
// 同一个措辞盖两种来源就会让人去做无效动作（error-handling.md：文案要指向正确的人工动作）。
function credentialHowto(source) {
  if (source === 'phone' || source === 'surge') return { msg: MSG_NEED_PHONE, howto: NO_CRED_HOWTO };
  return { msg: MSG_NEED_RELOGIN, howto: REFETCH_HOWTO };
}

/* ------------------------------------------------------------------ */
/* 单账号流程                                                          */
/* ------------------------------------------------------------------ */

async function runAccount(account, index, cfg, deps = {}) {
  const today = todayShanghai();
  const who = str(account.masked) || `账号${index + 1}`;
  const reporter = {
    tag: `账号${index + 1}(${who})`, masked: who, kind: null, signState: 'none',
    accumulateCount: null, prizes: [], lines: [], failed: false, invalid: false,
  };

  // ---- 0. 当天幂等（零请求、零通知）------------------------------------
  // 状态文件的键是 mobileMask（登录后才知道），所以先用 fp → mobileMask 索引定位条目。
  // 索引来自上一次成功取到凭证；没有索引（首跑/换号）就只能先取一次凭证 —— 这是「状态键用
  // mobileMask / 账号显示名」的必然代价，换来的是人眼可核对且不落明文手机号。
  const cachedMask = readMask(cfg.state, account.fp);
  if (cachedMask) {
    reporter.masked = cachedMask;
    reporter.tag = `账号${index + 1}(${cachedMask})`;
    const entry = cfg.dryRun ? readAccountState(cfg.state, cachedMask) : accountState(cfg.state, cachedMask);
    // 跨日重置（B1）：先把昨天/更早的 signDone 与 draws 作废，否则今天的每一轮都会因为
    // 「昨日已有结论」而漏抽。阈值在 loadState 后、任何判定之前（包括 isDayComplete）。
    resetForNewDay(entry, today);
    if (isDayComplete(entry, today, cfg.activities)) {
      log(`${reporter.tag} ℹ️ 今日已完成（签到 + 抽奖都有结论），跳过（零请求、零通知）`);
      reporter.kind = 'skipped_today';
      reporter.lines.push('ℹ️ 今日已完成，本轮跳过（零请求）');
      return reporter;
    }
  }

  // ---- 1. 取凭证：SANRI_PHONE（①）→ Surge（②）→ mint（③ 兜底）-----------
  // 三级来源见文件头。拿到 token 就往下走业务；三条都拿不到 = 零业务请求 + 可执行的下一步。
  // ⚠️ ① 一旦配了就不降级（用户显式给的优先，失败也直说失败）。
  let auth = null;
  try {
    auth = await resolveCredential(account, index, cfg, deps);
  } catch (e) {
    if (e instanceof SanriError && e.type === KIND.THROTTLED) {
      // 静默/限频是**正常**跳过（手滑多跑一次也会命中），不是凭证问题：
      // 只进面板日志，不进通知正文（见 buildNotice 对 skipped_throttle 的过滤）
      log(`ℹ️ ${reporter.tag} ${e.message}`);
      reporter.kind = 'skipped_throttle';
      return reporter;
    }
    // 两个「通道性」拒绝码（旧一键登录通道已关闭 / 运营商网络绑定）与「没有 mint 可兜底」
    // 处置相同：**未拿到可用凭证**，零业务请求，给出 4 步可执行指引。
    // 它们不是用户的凭证失效：文案不得出现「已失效 / 重新登录」（要么灌进失效 Bot，
    // 要么害用户去重抓一个不可能成功的模板）。
    if (e instanceof SanriError && (e.type === KIND.MINT_CLOSED || e.type === KIND.MINT_NETWORK
      || e.type === KIND.NO_CREDENTIAL)) {
      reporter.kind = e.type;   // mint_closed / mint_network / no_credential —— 分类本身要能看见
      reporter.noCredential = true;
      logErr(`${reporter.tag} ❌ 未拿到可用凭证（${e.message}），本次零业务请求`);
      reporter.lines.push('❌ 未拿到可用凭证（本次零业务请求）');
      reporter.lines.push(`   · 现签兜底不可用：${noticeSafe(e.message)}`);
      reporter.lines.push(...NO_CRED_HOWTO);
      return reporter;
    }
    if (e instanceof SanriError && (e.type === KIND.CREDENTIAL || e.type === KIND.NETWORK)) {
      // mint 通道（兜底）本身失败：非静默码 / 没拿到 JSESSIONID → 凭证类（人工重抓 mint）
      // 网络失败 → 网络类：等会儿重跑，不是凭证问题
      // 两种情况都**零业务请求**：没有 ticket 就拿不到 token，硬着头皮发业务请求只会变成匿名请求。
      const isCred = e.type === KIND.CREDENTIAL;
      reporter.invalid = isCred;
      reporter.failed = !isCred;
      reporter.kind = isCred ? KIND.LOGIN : KIND.NETWORK;
      reporter.authSource = 'mint';
      logErr(`${reporter.tag} ❌ 现签失败: ${e.message}`);
      // 记下真实失败原因，供后续被「间隔节流」跳过时回放（否则原因会被静默吃掉）
      try {
        const msRec = mintState(cfg.state, account.fp);
        msRec.lastError = String(e.message || '').slice(0, 200);
      } catch { /* 记账失败不影响主流程 */ }
      if (isCred) {
        reporter.lines.push(`❌ 未拿到可用凭证（现签兜底失败：${noticeSafe(e.message)}）：本次未发任何业务请求。`
          + `mint 模板可能已过期 —— ${MSG_NEED_RELOGIN}`);
        reporter.lines.push(...REFETCH_HOWTO);
        if (cachedMask) {
          const entry = cfg.dryRun ? readAccountState(cfg.state, cachedMask) : accountState(cfg.state, cachedMask);
          bumpCredFails(entry, today);
          reporter.lines.push(credentialHint(entry, 'mint'));
        }
      } else {
        reporter.lines.push(`❌ 取凭证请求失败（网络层：${noticeSafe(e.message)}）：本次未发任何业务请求；网络恢复后重跑即可`);
      }
      return reporter;
    }
    throw e;
  }
  // 现签计数/静默必须**立刻**落盘，否则「每天最多 3 次」形同虚设（后续步骤异常中断也会丢）
  if (!cfg.dryRun) saveState(cfg.stateFile, cfg.state);

  const cls = auth.cls || {};   // 只有 mint 通道会带 cls；① ② 走不通这里（它们要么成功要么抛）
  if (!auth.ok) {
    if (cls.kind === KIND.LOGIN || cls.kind === KIND.CREDENTIAL) {
      reporter.invalid = true;
      reporter.kind = KIND.LOGIN;
      reporter.authSource = 'mint';
      logErr(`${reporter.tag} ❌ 现签换取 token 失败（${describeLogin(cls)}）`);
      // 文案要求：说「现签失败」而不是「凭证失效」（用户手上本来就没有可失效的凭证），
      // 但处置动作同样是人工重抓 mint —— 所以仍走凭证通道（文案含「重新登录」关键词）。
      reporter.lines.push(`❌ 未拿到可用凭证（现签失败：login ${describeLogin(cls)}）：本次未发任何业务请求。`
        + `mint 模板很可能已过期 —— ${MSG_NEED_RELOGIN}`);
      reporter.lines.push(...REFETCH_HOWTO);
      if (cachedMask) {
        const entry = cfg.dryRun ? readAccountState(cfg.state, cachedMask) : accountState(cfg.state, cachedMask);
        bumpCredFails(entry, today);
        reporter.lines.push(credentialHint(entry, 'mint'));
      }
      return reporter;
    }
    // 契约漂移（code:"0" 但没有 token / 响应非 JSON）：fail-closed，零业务请求
    reporter.failed = true;
    reporter.kind = KIND.CONTRACT;
    logErr(`${reporter.tag} ❌ 现签换取 token 的响应不符合契约（${describeLogin(cls)}）`);
    // 契约漂移属**非凭证类**：服务端原文必须过 noticeSafe（万一它自带 expired/invalid
    // 之类的词，会让这条本该进普通 Bot 的通知被灌进失效 Bot）
    reporter.lines.push(`❌ 现签换取 token 的响应不符合契约（${noticeSafe(describeLogin(cls))}）：`
      + '为避免用空 token 发业务请求（那会变成匿名请求，可能回「今天没签过」就骗人已签），本次不发任何业务请求；请更新脚本');
    return reporter;
  }

  // 拿到 token（来源可能是 ① SANRI_PHONE / ② Surge / ③ mint）：
  // · mint 通道会顺带带回 mobileMask（服务端权威显示名）；① ② 没有，就用账号自己的显示名。
  // · account.phone 是业务请求头 phone 的**唯一**写入点（见 baseHeaders）。
  const masked = str(auth.mobileMask) || who;
  reporter.masked = masked;
  reporter.tag = `账号${index + 1}(${masked})`;
  reporter.authSource = auth.source;
  account.masked = masked;
  account.phone = auth.token;
  // 凭证类失败时的「怎么办」按来源分支（mint 要重抓模板，token 要重抓 phone 头）
  const how = credentialHowto(auth.source);
  // 只读模式不落任何状态（包括这份索引），否则等于「跑一次 dry-run 就当今天做过了」
  if (!cfg.dryRun) writeMask(cfg.state, account.fp, masked);

  const tag = reporter.tag;
  const entry = cfg.dryRun ? readAccountState(cfg.state, masked) : accountState(cfg.state, masked);
  resetForNewDay(entry, today);

  // ---- 2. 凭证存活探针（只读；拿到 token 之后、任何写请求之前）------------
  // 见文件头「凭证存活探针」：不管 token 从哪个来源来，连一个只读请求都被拒，就不能再发写请求。
  let probe = null;
  try {
    probe = await probeCredential(account, cfg, deps);
  } catch (e) {
    // 网络失败**不是**凭证死：不判死、不中止，继续走签到流程（写接口自己还有网络错误分支）
    logWarn(`${tag} ⚠️ 凭证探针网络失败（${e && e.message ? e.message : e}），跳过探针继续签到`);
  }
  if (probe) {
    log(`${tag} 🔑 凭证探针 residueLotteryCount(activityId=${probe.activityId})`
      + ` → HTTP ${probe.res.httpStatus} ${describeClass(probe.cls)}`
      + ` 次数=${probe.scalar ? String(probe.raw) : '未知'}`);
    if (probe.cls.kind === KIND.CREDENTIAL) {
      // 零写请求立即中止；不写 date / signDone / draws（重跑还会重新判一次再签到）
      logErr(`${tag} 🔑 凭证探针判定 token 不被接受（来源=${auth.source}，code=${probe.cls.code || 'HTTP'}）→ 本次零写请求，不落 signDone`);
      reporter.invalid = true;
      reporter.kind = KIND.CREDENTIAL;
      reporter.lines.push(`❌ 凭证探针（只读 residueLotteryCount）判定本次 token 不被接受（来源=${auth.source}，code=${probe.cls.code || 'HTTP'}）：`
        + `本次未发任何写请求；${how.msg}`);
      reporter.lines.push(...how.howto);
      bumpCredFails(entry, today);
      reporter.lines.push(credentialHint(entry, auth.source));
      return reporter;
    }
    if (!probe.cls.ok) {
      // 探针只对「凭证不可用」有结论；其他异常（契约漂移/未知码）不据此判死，也不拦签到
      logWarn(`${tag} ⚠️ 凭证探针无明确结论（${describeFailure(probe.cls)}），继续走签到流程`);
    }
  }

  // ---- 3. 签到状态 ----------------------------------------------------
  let sign;
  try {
    sign = await getSignInfo(account, cfg, deps);
  } catch (e) {
    logErr(`${tag} ❌ 查签到状态失败: ${e && e.message ? e.message : e}`);
    reporter.failed = true;
    reporter.lines.push(`❌ 查签到状态失败（网络层）: ${noticeSafe(e && e.message ? e.message : e)}`);
    return reporter;
  }
  log(`${tag} getTaskSignInfo → HTTP ${sign.res.httpStatus} ${describeClass(sign.cls)}`
    + ` signToday=${sign.info.signToday} accumulateCount=${sign.info.accumulateCount}`);

  if (!sign.cls.ok) {
    if (sign.cls.kind === KIND.CREDENTIAL) {
      reporter.invalid = true;
      reporter.lines.push(`❌ 签到凭证不可用（code=${sign.cls.code || 'HTTP'}）：${how.msg}`);
      reporter.lines.push(...how.howto);
      bumpCredFails(entry, today);   // 先累加再出提示，否则「连续失败」永远慢一天
      reporter.lines.push(credentialHint(entry, auth.source));
    } else {
      reporter.failed = true;
      reporter.lines.push(`❌ 查签到状态失败：${describeFailure(sign.cls)}`);
    }
    reporter.kind = sign.cls.kind;
    return reporter;
  }

  // 三态里的「不知道」≠「没有」：signToday 不是布尔就不发签到（避免重复签），也不猜成功
  if (sign.info.signToday === null) {
    reporter.failed = true;
    reporter.kind = KIND.UNKNOWN;
    reporter.lines.push('❌ 签到状态字段缺失（data.signToday 不是布尔值），为避免重复签到本次不发 task/sign；'
      + '接口契约可能已变，请核对面板日志');
    return reporter;
  }

  // 凭证已经正常工作 → 连续失败计数归零，并清掉 lastCredFailDate：
  // 否则当天「成功 → 又失败」时，bumpCredFails 会因 lastCredFailDate===today 而不计这天。
  entry.credFails = 0;
  entry.lastCredFailDate = '';

  // ---- 2. 签到（signToday === true 时**绝对不能**发 task/sign）---------
  let signDone = false;
  let accumulate = sign.info.accumulateCount;
  if (sign.info.signToday) {
    signDone = true;
    reporter.signState = 'already';
    reporter.lines.push('✅ 今日已签到（无需重复签到）');
  } else {
    // 签到失败**不直接 return**（design §4 步骤 4）：抽奖次数是独立的东西，
    // 签到没成不代表没有次数可抽，漏掉一次机会更亏。只有「凭证已死」才短路 ——
    // 同一个 token 接着打只会重复失败，还白给风控看。
    let signed = null;
    try {
      signed = await doSign(account, cfg, deps);
    } catch (e) {
      logErr(`${tag} ❌ 签到请求失败: ${e && e.message ? e.message : e}`);
      reporter.failed = true;
      reporter.kind = KIND.NETWORK;
      reporter.lines.push(`❌ 签到请求失败（网络层）: ${noticeSafe(e && e.message ? e.message : e)}`);
    }
    if (signed) {
      log(`${tag} task/sign → kind=${signed.kind}${signed.cls ? ` ${describeClass(signed.cls)}` : ''}`);

      if (signed.kind === 'ok' || signed.kind === 'already') {
        signDone = true;
        reporter.signState = signed.kind === 'ok' ? 'signed' : 'already';
        // 签到响应里的累计天数未实测 → 先按「签到前 +1」推导，再靠回读复核到真值。
        // ⚠️ 必须用 numOrNull：Number(null) === 0，会把「不知道几天」写成「1 天」并对用户报假数字。
        const baseCount = numOrNull(accumulate);
        accumulate = baseCount === null
          ? null : baseCount + (signed.kind === 'ok' ? 1 : 0);
        if (signed.kind === 'ok') {
          const verified = await verifySigned(account, cfg, deps);
          if (verified.status === 'confirmed') {
            const verifiedCount = numOrNull(verified.info.accumulateCount);
            if (verifiedCount !== null) {
              accumulate = verifiedCount;
            }
            log(`${tag} 签到复核通过（第 ${verified.tries} 次回读到 signToday=true，累计 ${accumulate === null ? '未知' : `${accumulate} 天`}）`);
            reporter.lines.push(`✅ 签到成功${accumulate !== null ? `（累计 ${accumulate} 天，已回读复核）` : '（已回读复核）'}`);
          } else if (verified.status === 'unconfirmed') {
            // 写接口空转：服务端说成功，但状态没变 → fail-closed，不能冒充成功
            signDone = false;
            reporter.failed = true;
            log(`${tag} ⚠️ task/sign 返回成功但回读 ${verified.tries} 次 signToday 仍为 false，按未签到处理`);
            reporter.lines.push(`❌ 签到接口返回成功，但服务端 signToday 仍为 false（疑似空转），已按失败处理`);
          } else {
            logWarn(`${tag} ⚠️ 签到回读复核失败（${verified.detail}），按接口返回的成功处理（未确认）`);
            reporter.lines.push(`⚠️ 签到接口返回成功，但回读复核失败（${noticeSafe(verified.detail)}）—— 请到 App 核对`);
          }
        } else {
          reporter.lines.push('✅ 服务端提示今日已签到（幂等码未实测，按成功处理；面板日志里有原文）');
        }
      } else if (signed.kind === 'dry_run') {
        reporter.signState = 'dry_run';
        reporter.lines.push('ℹ️ 只读模式：本次应签到，但未发 task/sign');
      } else if (signed.kind === KIND.CREDENTIAL) {
        reporter.invalid = true;
        reporter.lines.push(`❌ 签到凭证不可用（code=${signed.cls.code || 'HTTP'}）：${how.msg}`);
        reporter.lines.push(...how.howto);
        bumpCredFails(entry, today);
        reporter.lines.push(credentialHint(entry, auth.source));
        reporter.kind = KIND.CREDENTIAL;
        // 凭证已失效：同一个 token 接着查抽奖只会重复失败，不再往下跑
        return reporter;
      } else {
        reporter.failed = true;
        reporter.lines.push(`❌ 签到失败：${describeFailure(signed.cls)}`);
      }
    }
  }

  reporter.accumulateCount = accumulate;
  // 奖励文案必须区分档位（契约 §5.1）：
  //   第 1 天：奖励**直接到账**，自动进卡包 —— 可以说「直发」。
  //   第 2 天起：档位奖励/抽奖资格需要用户**到兑换专区抽取**，签到本身不发奖 ——
  //   以前一句「签到直发：…（自动进卡包，无需领券）」会把抽奖资格说成已到账，误导用户不去抽。
  const award = signDone ? findSignAward(sign.info.skuList, accumulate) : null;
  if (award) {
    const name = noticeSafe(award.name);
    if (award.signDays === 1) {
      reporter.lines.push(`🎁 签到直发（第 1 日）：${name}（自动进卡包，无需领券）`);
    } else if (/资格/.test(award.name)) {
      reporter.lines.push(`🎁 签到档位（第 ${award.signDays} 日）：${name}（签到不发奖，需到「兑换专区」抽取）`);
    } else {
      reporter.lines.push(`🎁 签到档位（第 ${award.signDays} 日）：${name}（需到「兑换专区」抽取，不会自动进卡包）`);
    }
  }
  entry.accumulateCountAfter = accumulate;

  // ---- 3. 抽奖（三个活动串行，单个失败不影响其余）----------------------
  // 注意顺序：residueLotteryCount 的正式查询全部发生在这之后（即**签到之后**）。
  // 这是有意的 —— 签到会新增抽奖资格，签到前查到的「次数=0」不能当结论复用（当日变体，B1）。
  // 凭证探针那一次只读请求同样不复用（见 probeCredential 注释）。
  const draws = await runDraws(account, cfg, entry, today, deps);
  for (const d of draws) {
    if (d.skipped) {
      // 今日已有结论：只加一行说明，settlement/prize/detail 原样保留（不降级、不重计中奖）
      const extra = d.detail ? `（${noticeSafe(d.detail)}）` : '';
      reporter.lines.push(`ℹ️ ${d.label}：今日已有结论，本轮跳过${extra}`);
    } else if (d.settlement === 'won') {
      reporter.prizes.push(d.detail);
      reporter.lines.push(`🎰 ${d.label}：${noticeSafe(d.detail)}`);
    } else if (d.settlement === 'error') {
      if (d.invalid) {
        reporter.invalid = true;
        reporter.lines.push(`❌ ${d.label}：${d.detail}；${how.msg}`);
      } else {
        reporter.failed = true;
        reporter.lines.push(`❌ ${d.label}：${noticeSafe(d.detail)}`);
      }
    } else {
      reporter.lines.push(`ℹ️ ${d.label}：${noticeSafe(d.detail)}`);
    }
  }
  if (reporter.invalid) {
    reporter.lines.push(...how.howto);
    bumpCredFails(entry, today);
    reporter.lines.push(credentialHint(entry, auth.source));
  }

  // ---- 4. 状态落盘（只读模式不改状态，否则会伪造「今天已完成」）--------
  if (!cfg.dryRun) {
    entry.date = today;
    entry.signDone = signDone;
    entry.accumulateCount = accumulate;
    entry.draws = entry.draws && typeof entry.draws === 'object' ? entry.draws : {};
    // 显式记下这批结论的**归属日期**（B1）：runDraws 的跳过判定与 isDayComplete
    // 都只认这一天的结论，跨日必须重新查/抽。
    entry.drawsDate = today;
    for (const d of draws) {
      entry.draws[d.id] = {
        settlement: d.settlement,
        count: d.count,
        prize: d.prize || null,
        detail: redact(d.detail),
        at: isoShanghai(),
      };
    }
    entry.notifiedAt = isoShanghai();
    entry.updatedAt = isoShanghai();
  }

  reporter.kind = reporter.failed ? 'error' : reporter.invalid ? KIND.CREDENTIAL : 'done';
  return reporter;
}

/* ------------------------------------------------------------------ */
/* 通知                                                                */
/* ------------------------------------------------------------------ */

function buildCandidates() {
  const fixed = [];
  const explicit = str(process.env.SANRI_NOTIFY_MODULE);
  if (explicit) fixed.push(explicit);
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
      const entries = fs.readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory()).slice(0, 50);
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
  if (process.env.SANRI_PUSH === '0') {
    log('（SANRI_PUSH=0，未发送通知）');
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

// 正文里所有动态文本都已收口（noticeSafe）；verdict 在**所有子步骤跑完之后**才定稿，
// 避免出现「标题写成功、正文命中失效关键词」的自相矛盾。
function buildNotice(reporters, cfg) {
  const lines = [];
  // 静默/限频跳过的账号**不进通知正文**（见文件头「风控纪律」）：它们既不是失败也没有可行动项，
  // 一条推送里全是「静默中」只会让用户关掉通知。要确认细节就看面板日志。
  const visible = (Array.isArray(reporters) ? reporters : []).filter((r) => r && r.kind !== 'skipped_throttle');
  // 「未拿到可用凭证」也是一个可 actionable 的失败（要去开活动页 / 填变量），归入 problems。
  const problems = visible.filter((r) => r.failed || r.invalid || r.noCredential);
  const noCred = problems.filter((r) => r.noCredential);
  const skipped = visible.filter((r) => r.kind === 'skipped_today');
  const wins = visible.reduce((n, r) => n + r.prizes.length, 0);

  for (const r of visible) {
    lines.push(`【${r.tag}】`);
    for (const l of r.lines) lines.push(`  ${l}`);
    lines.push('');
  }

  if (cfg.dryRun) {
    // 没拿到凭证时不能说「已取到凭证」（否则与正文结论自相矛盾）
    lines.push(noCred.length
      ? '（只读模式 SANRI_DRY_RUN=1：本次未拿到凭证，零业务请求，不落状态文件）'
      : '（只读模式 SANRI_DRY_RUN=1：已取到凭证，但未发 task/sign、lottery/lottery，且不落状态文件）');
  }

  let verdict;
  if (problems.length && noCred.length === problems.length) verdict = '❌ 未拿到可用凭证';
  else if (problems.length) verdict = `❌ ${problems.length}/${visible.length} 个账号失败`;
  else if (wins) verdict = `✅ 签到完成，抽中 ${wins} 项`;
  else if (skipped.length === visible.length) verdict = 'ℹ️ 今日已完成';
  else if (cfg.dryRun) verdict = 'ℹ️ 只读检查完成';
  else verdict = '✅ 签到完成';

  // cron 是每 10 分钟 ⇒ 同一份凭证失效会反复碰到；通知已按「每账号每天一次」节流（throttleNotice），
  // 但重跑命令仍然要写在正文里（手动重跑是拿到新 token 后最快的验证方式）。
  if (problems.length) {
    lines.push('👉 本脚本 cron 是 */10 * * * *（每 10 分钟扫一次 Surge，撞上页面登录那一刻）');
    lines.push(`👉 拿到新 token / 排障后请手动重跑: ${RERUN_CMD}`);
  }

  lines.push(`执行时间: ${hhmmShanghai()}（北京时间）`);
  return { title: `${TASK_TITLE} ${verdict}`, content: lines.join('\n') };
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

// 全账号「本轮无需通知」判定（design §4 步骤 2：零请求**零通知**）。
// 三类都算「安静结束」：
//   ① 今日已完成（skipped_today）
//   ② 现签被风控静默/限频跳过（skipped_throttle）
//   ③ 被 throttleNotice 节流掉的重复告警（suppressNotify）
// 抽成纯函数是为了能被离线自检直接断言：以前这段判定写在 main 里，
// 自检只能把正确实现拄一遍（同义反复），删掉真实现也照样全绿。
function allAccountsQuiet(reporters) {
  return Array.isArray(reporters) && reporters.length > 0
    && reporters.every((r) => r && (r.kind === 'skipped_today' || r.kind === 'skipped_throttle'
      || r.suppressNotify === true));
}

// 通知节流：「未拿到凭证 / 凭证类失败」每账号**每天最多推送一次**。
// 为什么必须有：cron 是每 10 分钟一次，而同一份失效凭证 / “还没开活动页”这个状态会持续一整天 ——
// 不节流就是 144 条重复推送，用户会直接关掉通知（qwhd 已踩过，其结论是「凭证类失败每账号每天一次」）。
// 节流只影响**推送**：日志照打，首次告警那轮退出码仍为 1（面板每天最多红一次）。
// 状态存在 state.mint[fp].noticeDate（那里本来就是「凭证获取的薄记」，不动 accounts 条目的结构）。
function throttleNotice(reporter, account, cfg, today = todayShanghai()) {
  if (!reporter || (!reporter.invalid && !reporter.noCredential)) return reporter;
  const ms = mintState(cfg.state, account.fp);
  if (ms.noticeDate === today) {
    reporter.suppressNotify = true;
    log(`${reporter.tag} ℹ️ 本次告警今天已推送过（每账号每天一次），不发通知；详情见面板日志`);
    return reporter;
  }
  ms.noticeDate = today;
  return reporter;
}

// 配置缺失通知的正文（**不走统一守卫**的发送路径，所以自带两道保）：
//   ① 文案不含「已失效 / 重新登录 / 发生异常」→ 不会进失效提醒 Bot；
//   ② 必带可直接复制的重跑命令（cron 每 10 分钟一次，总会有一轮能用上）。
// 抽成函数同样是为了可被自检直接断言（而不是在自检里拼一份相同的字符串）。
function buildConfigMissingNotice(text) {
  return {
    title: `${TASK_TITLE} ❌ 未配置`,
    content: `${text}\n👉 配好后重跑: ${RERUN_CMD}\n执行时间: ${hhmmShanghai()}（北京时间）`,
  };
}

// 未配置告警的节流判定（纯函数，便于离线断言）：同一份「未配置」每天只推一次。
// 为什么需要：cron 是每 10 分钟一次，而「变量没填」会持续一整天 —— 不节流就是 144 条推送，
// 用户会直接关掉通知（然后真正的失败通知也就看不到了）。面板日志每轮照打。
function needsConfigMissingNotice(cfg, today = todayShanghai()) {
  if (!cfg.state || typeof cfg.state !== 'object') cfg.state = emptyState();
  if (!cfg.state.notice || typeof cfg.state.notice !== 'object') cfg.state.notice = {};
  if (cfg.state.notice.configMissingDate === today) return false;
  cfg.state.notice.configMissingDate = today;
  return true;
}

async function reportConfigMissing(cfg, text) {
  for (const line of String(text).split('\n')) logErr(line);
  process.exitCode = 1;
  // ⚠️ 先把**既有**状态文件读回来再写：config_missing 不等于「今天没做过事」，
  // 直接拿 readConfig 里的空 state 落盘会把当天的 signDone / 抽奖结论 / 凭证计数抹掉。
  cfg.state = loadState(cfg.stateFile);
  if (!needsConfigMissingNotice(cfg)) {
    log('ℹ️ 未配置告警今天已推送过（每天一次节流），本次不发通知；配好后重跑即可');
    return;
  }
  saveState(cfg.stateFile, cfg.state);
  try {
    const notice = buildConfigMissingNotice(text);
    await notify(notice.title, notice.content);
  } catch { /* 通知失败不覆盖原问题 */ }
}

async function main() {
  const cfg = readConfig();
  log(`启动 ${TASK_TITLE}（${hhmmShanghai()}${cfg.dryRun ? '，只读模式' : ''}）`);

  // 配置缺失 → 本地判定，零请求（不发明任何请求是纪律）：
  // 三个来源（SANRI_PHONE / Surge / SANRI_ACCOUNTS）一个都没配才算缺配置。
  // ⚠️ 纯 Surge 模式**不算**缺配置：它的凭证在 runAccount 里按需捡，见 buildAccountList 的注释。
  if (!hasAnyCredentialSource(cfg)) {
    await reportConfigMissing(cfg, MSG_MISSING);
    return;
  }
  if (cfg.activityProblem) {
    await reportConfigMissing(cfg, `❌ ${cfg.activityProblem}\n请修正环境变量 SANRI_ACTIVITIES，或删掉它使用内置的默认活动表`);
    return;
  }

  // SANRI_ACCOUNTS 可选（有 token 就不需要 mint）；只是**写了的**必须完整。
  // 纯 Surge 模式在这里拿到 1 个占位账号 → 账号数为 1，不会掉进下面的「未配置」分支。
  const { accounts, tokens, problems, placeholder } = buildAccountList(cfg);
  for (const p of problems) logWarn(`⚠️ ${p}`);
  if (!accounts.length) {
    const total = problems.length;
    await reportConfigMissing(cfg, total
      ? `❌ 已配置的凭证来源解析失败（${total} 条，原因见上方 ⚠️ 日志）\n\n${MSG_MISSING}`
      : MSG_MISSING);
    return;
  }
  if (placeholder) {
    log('ℹ️ 只配了 Surge（无 SANRI_PHONE / SANRI_ACCOUNTS）：建 1 个占位账号，运行时从 Surge 抓包里捡 phone 头');
  }
  log(`待处理账号 ${accounts.length} 个（来源：SANRI_PHONE ${tokens.length} 个`
    + ` / Surge ${cfg.surgeUrl ? `${cfg.surgeUrl} 已配置` : '未配置'}`
    + ` / mint ${accounts.filter((a) => a.mint).length} 份模板）；`
    + `抽奖活动 ${cfg.activities.map((a) => `${a.id}`).join('/')}`);

  cfg.state = loadState(cfg.stateFile);

  const reporters = [];
  for (let i = 0; i < accounts.length; i += 1) {
    let reporter;
    try {
      reporter = await runAccount(accounts[i], i, cfg);
    } catch (e) {
      const tag = `账号${i + 1}(${accounts[i].masked || '未知'})`;
      logErr(`${tag} ❌ 异常: ${e && e.message ? e.message : e}`);
      reporter = {
        tag, masked: accounts[i].masked, kind: 'error', signState: 'none',
        accumulateCount: null, prizes: [], failed: true, invalid: false,
        lines: [`❌ 发生异常: ${noticeSafe(e && e.message ? e.message : e)}`],
      };
    }
    // 节流必须在 saveState **之前**：noticeDate 也要落盘，否则节流器只在本轮生效
    reporters.push(throttleNotice(reporter, accounts[i], cfg));
    if (!cfg.dryRun) saveState(cfg.stateFile, cfg.state);
    if (i < accounts.length - 1) await sleep(cfg.gapMs);
  }

  // design §4 步骤 2：全账号本轮无需通知（今日已完成 / 现签静默 / 今天已告警过）→ 零通知。
  if (allAccountsQuiet(reporters)) {
    log('全部账号本轮无需通知（今日已完成 / 凭证获取静默 / 今天已告警过），零通知，直接结束');
    if (reporters.some((r) => (r.failed || r.invalid || r.noCredential) && !r.suppressNotify)) {
      process.exitCode = 1;
    }
    return;
  }

  const { title, content } = buildNotice(reporters, cfg);
  log(`\n${title}\n${content}`);
  await notify(title, content);

  if (reporters.some((r) => (r.failed || r.invalid || r.noCredential) && !r.suppressNotify)) {
    process.exitCode = 1;
  }
}

/* ------------------------------------------------------------------ */
/* 离线自检（--selfcheck）：全程**不发**网络请求                          */
/* ------------------------------------------------------------------ */

function makeTestCfg(overrides = {}) {
  const base = {
    activities: DEFAULT_ACTIVITIES.map((a) => ({ ...a })),
    taskId: DEFAULT_TASK_ID,
    channelNo: DEFAULT_CHANNEL_NO,
    referer: DEFAULT_REFERER,
    timeoutMs: 1000,
    retryMs: 1,
    drawRetry: 0,
    gapMs: 0,
    dryRun: false,
    push: false,
    verifyAttempts: SIGN_VERIFY_ATTEMPTS,
    verifyMs: 1,   // 自检用注入的 sleep，不会真等；这里只是把窗口对齐真实默认
    stateFile: path.join(os.tmpdir(), 'sanri-selfcheck-unused.json'),
    state: emptyState(),
    accountsRaw: '',
    phoneRaw: '',
    surgeUrl: '',
    surgeKey: '',
    surgeSession: 'auto',
    tokenMaxAgeMin: DEFAULT_TOKEN_MAX_AGE_MIN,
  };
  return { ...base, ...overrides };
}

const reply = (json, httpStatus = 200) => ({ httpStatus, text: JSON.stringify(json) });

async function selfcheck() {
  let pass = 0;
  const fail = [];
  const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) pass += 1;
    else fail.push(`${name}: 期望 ${JSON.stringify(expected)} 实际 ${JSON.stringify(actual)}`);
  };
  const checkTrue = (name, cond) => check(name, Boolean(cond), true);

  // 0) 离线守卫：把默认网络层换成必抛桩。
  //    「自检真的离线」的验证方法：把这个桩换回真 transport（或注释掉本段）后，
  //    自检里任何漏掉 deps 的调用都会真的发请求；有桩时它们只会拿到 network 错误。
  //    同时把 globalThis.fetch 也换成抛错桩（本脚本不用 fetch，防止将来有人顺手引入）。
  const netHits = [];
  const offlineStub = (req) => { netHits.push(req && req.path); throw new SanriError(KIND.NETWORK, '自检禁止联网'); };
  const realTransport = transport;
  const realFetch = globalThis.fetch;
  transport = offlineStub;
  globalThis.fetch = () => { throw new Error('自检禁止联网(fetch)'); };

  // 夹具一律用**虚构值**（真实 mint 模板 / token 不得进源码/自检）
  const FAKE = 'ZzFakeCipherValu0123456789'; // 26 字符，明显虚构（当 token 形态用）
  registerSecret(FAKE);

  // ---- 现签链路夹具（① autoLogin / ② userLoginV2）----------------------------------
  // 一律本地构造，不外网。业务夹具只需关心业务接口：①② 由 authDeps 统一应答，
  // 且**不记入** hits，以便既有「只发了 N 次业务请求」的断言保持不变。
  const MINT_TICKET = 'JSESSIONID=FakeSessionId0123456789; UID=UIDfake; Comment=SessionServer-unity; '
    + 'Path=/;HTTPOnly; ticketID=POD9; Secure';
  const FAKE_TOKEN = 'FakeLoginTokenA1b2C3d4E5f6G7h8I9j0'; // 39 字符，明显虚构
  const FAKE_MASK = '138****0001';
  const mintReply = (retCode = '000000', retDesc = '成功') => ({
    httpStatus: 200,
    setCookies: retCode === '000000' ? [MINT_TICKET] : [],
    text: aesEncryptB64(MINT_KEY_RESP, MINT_IV, JSON.stringify({ retCode, retDesc })),
  });
  const loginReply = (mask = FAKE_MASK, dataOver = {}) => reply({
    code: '0', message: '成功!',
    data: { token: FAKE_TOKEN, refreshToken: 'FakeRefreshToken0123456789', mobileMask: mask, ...dataOver },
  });

  // 账号夹具：配置里**没有**任何可用凭证，只有 mint 模板 —— 业务请求头的 token 只能来自 login。
  const fakeAccount = (n) => {
    const nn = String(n).padStart(2, '0');
    const tel = `138000000${nn}`;
    const mint = { xk: `FakeXk${nn}`, reqBody: { cellNum: `FakeCellNum${nn}` } };
    return { tel, fp: fingerprint(mint, tel), mint, masked: maskPhone(tel), phone: '' };
  };

  // 把「业务 stub」包一层 auth：mint/login 就地应答，其余交给 stub。
  const authDeps = (stub, opts = {}) => {
    const seen = [];
    const mask = opts.mask || FAKE_MASK;
    const request = (req) => {
      if (req.url === MINT_URL) { seen.push('mint'); return (opts.mint || (() => mintReply()))(req); }
      if (req.url === LOGIN_URL) { seen.push('login'); return (opts.login || (() => loginReply(mask)))(req); }
      return stub(req);
    };
    return { request, sleep: opts.sleep || (async () => {}), seen, mask };
  };

  // 1) 脱敏：三形态 + 裸值，一个都不能漏
  check('mask-26', maskSecret(FAKE), 'ZzFa…6789');
  check('mask-short', maskSecret('short'), '***');
  const redactCases = [
    ['kv', `phone=${FAKE}`],
    ['colon', `phone: ${FAKE}`],
    ['json', `{"phone":"${FAKE}"}`],
    ['naked', `随手打的 ${FAKE} 裸值`],
  ];
  for (const [label, input] of redactCases) {
    const out = redact(input);
    check(`redact-leak(${label})`, out.includes(FAKE), false);
    checkTrue(`redact-masked(${label})`, out.includes('ZzFa…6789'));
  }
  check('notice-no-leak', noticeSafe(`{"phone":"${FAKE}"}`).includes(FAKE), false);
  // token / refreshToken 也是凭证：响应被直接 stringify 时不能漏
  check('redact-token', redact(`{"token":"${FAKE_TOKEN}"}`).includes(FAKE_TOKEN), false);
  check('redact-refresh-token', redact(`{"refreshToken":"${FAKE_TOKEN}"}`).includes(FAKE_TOKEN), false);
  // 中文说明不得被当成「值」脱敏（实测踩到过：通知里「多个账号」被吃掉）
  check('redact-keeps-chinese', redact('面板新建 SANRI_ACCOUNTS = 该模板；多个账号用 & 分隔'),
    '面板新建 SANRI_ACCOUNTS = 该模板；多个账号用 & 分隔');
  check('redact-keeps-msg-missing', redact(MSG_MISSING), MSG_MISSING);
  check('redact-keeps-refetch-howto', redact(REFETCH_HOWTO.join('\n')), REFETCH_HOWTO.join('\n'));
  check('redact-ascii-value', redact('SANRI_ACCOUNTS=AbCdEfGh12345678 end'), 'SANRI_ACCOUNTS=AbCd…5678 end');

  // 1b) 手机号脱敏（登录前的显示名）
  check('mask-phone', maskPhone('13800138000'), '138****8000');
  check('mask-phone-bad', maskPhone('abc'), '***');
  check('mask-phone-empty', maskPhone(''), '');

  // 2) 配置解析：JSON 对象（每项一份 mint 模板）、必需字段、保序去重
  const accJson = (n) => JSON.stringify(fakeAccount(n));
  const p1 = parseAccounts(`${accJson(1)}&${accJson(2)}\n${accJson(1)}\n\n`);
  check('parse-count', p1.accounts.length, 2);
  check('parse-order', p1.accounts.map((a) => a.tel.slice(-2)), ['01', '02']);
  check('parse-problems', p1.problems.length, 0);
  check('parse-no-config-phone', p1.accounts.map((a) => a.phone), ['', '']);   // 配置里没有凭证
  check('parse-masked', p1.accounts[0].masked, '138****0001');
  check('parse-fp-stable', p1.accounts[0].fp, fingerprint(fakeAccount(1).mint, fakeAccount(1).tel));
  const p2 = parseAccounts('not-json');
  check('parse-json-rejected', p2.accounts.length, 0);
  checkTrue('parse-json-problem', p2.problems[0] && p2.problems[0].includes('SANRI_ACCOUNTS[0]'));
  const p2b = parseAccounts('[{"tel":"1"}]');
  check('parse-array-rejected', p2b.accounts.length, 0);
  const p3 = parseAccounts(`${JSON.stringify({ tel: '13800000003' })}&${accJson(3)}`);
  // mint 现在可选（有 token 就不需要现签）：只写 tel 的对象也算合法账号（mint=null）
  check('parse-no-mint-kept', p3.accounts.length, 2);
  check('parse-no-mint-problem', p3.problems.length, 0);
  check('parse-no-mint-null', p3.accounts[0].mint, null);
  checkTrue('parse-no-mint-fp', p3.accounts[0].fp.startsWith('tel:'));
  const p4 = parseAccounts(JSON.stringify({ mint: { xk: 'FakeXkOnly' } }));
  check('parse-no-cellnum', p4.accounts.length, 0);
  checkTrue('parse-no-cellnum-wording', p4.problems[0].includes('mint.reqBody.cellNum'));
  // tel 可选（czrhd 的账号对象拷过来也能用）；没有 tel 时显示名退回指纹前缀
  const p5 = parseAccounts(JSON.stringify({ mint: { xk: 'FakeXkOnly', reqBody: { cellNum: 'FakeCell' } } }));
  check('parse-mint-only-ok', p5.accounts.length, 1);
  checkTrue('parse-mint-only-mask', p5.accounts[0].masked.startsWith('fp:'));
  check('parse-empty', parseAccounts('').accounts.length, 0);

  // 3) 今日已签三态（true / false / 不知道）
  check('sign-true', parseSignInfo({ data: { signToday: true, accumulateCount: 3, skuList: [] } }).signToday, true);
  check('sign-false', parseSignInfo({ data: { signToday: false, accumulateCount: 1 } }).signToday, false);
  check('sign-missing-field', parseSignInfo({ data: { accumulateCount: 2 } }).signToday, null);
  check('sign-no-data', parseSignInfo({ resultCode: 0 }).signToday, null);
  check('sign-count', parseSignInfo({ data: { accumulateCount: '2' } }).accumulateCount, 2);
  // S5：缺失/null 不得回落成 0（Number(null) === 0 是个坑）
  check('sign-count-null', parseSignInfo({ data: { accumulateCount: null } }).accumulateCount, null);
  check('sign-count-missing', parseSignInfo({ data: {} }).accumulateCount, null);

  // 4) 业务码分类（两个外壳分开解析）+ 未知码 fail-closed
  const C = (family, json, httpStatus = 200) => classify(family, reply(json, httpStatus));
  check('cls-task-0', C('task', { resultCode: 0, msg: 'success', data: {} }).kind, KIND.OK);
  check('cls-task-1118', C('task', { resultCode: -1118, msg: '任务不存在' }).kind, KIND.TASK_GONE);
  check('cls-task-unknown', C('task', { resultCode: -1234 }).kind, KIND.UNKNOWN);
  checkTrue('cls-task-unknown-not-ok', C('task', { resultCode: -1234 }).ok === false);
  check('cls-lottery-200', C('lottery', { code: '200', msg: '操作成功', data: 0, success: true }).kind, KIND.OK);
  check('cls-lottery-200-number', C('lottery', { code: 200, data: 0 }).kind, KIND.OK);
  check('cls-lottery-40', C('lottery', { code: '40', msg: '无权限' }).kind, KIND.CREDENTIAL);
  check('cls-task-40', C('task', { code: '40', msg: '无权限' }).kind, KIND.CREDENTIAL);
  check('cls-lottery-61003', C('lottery', { code: '-61003', msg: '错误的活动信息，非抽奖活动！' }).kind, KIND.ACTIVITY_GONE);
  check('cls-lottery-unknown', C('lottery', { code: '500' }).kind, KIND.UNKNOWN);
  checkTrue('cls-lottery-unknown-not-ok', C('lottery', { code: '500' }).ok === false);
  check('cls-400-contract', classify('lottery', { httpStatus: 400, text: '【channelNo】must not be null;', json: null }).kind, KIND.CONTRACT);
  check('cls-403-credential', classify('lottery', { httpStatus: 403, text: '', json: null }).kind, KIND.CREDENTIAL);
  check('cls-nonjson-unknown', classify('task', { httpStatus: 200, text: '<html>502</html>', json: null }).kind, KIND.UNKNOWN);
  // success 字段不得参与判定（checkConsecutiveLotteryVisibility 就是 success:false 但有 data）
  check('cls-ignore-success', C('lottery', { code: '200', success: false, data: 1 }).kind, KIND.OK);
  // 二次嵌套（2026-11-25 实测样本）：外层 code:200 + success:true，真正的码在内层 resultCode
  const NESTED_CRED = { code: '200', msg: '操作成功', data: { resultCode: -516, msg: '用户未登录或登录已失效', data: null }, success: true };
  check('cls-nested-cred-lottery', C('lottery', NESTED_CRED).kind, KIND.CREDENTIAL);
  check('cls-nested-cred-task', C('task', { resultCode: 0, data: { resultCode: -516, msg: '用户未登录或登录已失效', data: null } }).kind, KIND.CREDENTIAL);
  checkTrue('cls-nested-cred-not-ok', C('lottery', NESTED_CRED).ok === false);
  check('cls-nested-ok', C('lottery', { code: '200', data: { resultCode: 0, msg: 'ok', data: 2 }, success: true }).kind, KIND.OK);
  check('cls-nested-unknown', C('lottery', { code: '200', data: { resultCode: -999, msg: '?' }, success: true }).kind, KIND.UNKNOWN);
  // 风控评分拒绝（2026-11-28 实测抽奖真实响应）：判据只用 explain / risk 结构字段，
  // 不看 code:-1 也不看 message 文案（两者都可能变）。
  const RISK_REAL = {
    code: -1,
    data: { explain: 'SCORE_REFUSE', level: 5, risk: true,
      url: 'https://dev.coc.10086.cn/coc3/gr/static-2c/risk-verify/#/orderFail?riskActionLogId=x&phone=138****1000' },
    message: '访问过于频繁,请稍后再试',
  };
  check('cls-risk-lottery', C('lottery', RISK_REAL).kind, KIND.RISK);
  checkTrue('cls-risk-not-ok', C('lottery', RISK_REAL).ok === false);
  checkTrue('cls-risk-not-credential', C('lottery', RISK_REAL).kind !== KIND.CREDENTIAL);
  checkTrue('cls-risk-not-unknown', C('lottery', RISK_REAL).kind !== KIND.UNKNOWN);
  // risk:true 单独也能判（不依赖 explain）
  check('cls-risk-by-flag', isRiskPayload({ code: -1, data: { risk: true } }), true);
  // explain 单独也能判（大小写不敏感）
  check('cls-risk-by-explain', isRiskPayload({ data: { explain: 'score_refuse' } }), true);
  // 反面：普通 data 不是风控（避免把所有 -1 都当风控）
  check('cls-risk-not-plain', isRiskPayload({ code: -1, data: null }), false);
  check('cls-risk-not-nested', isRiskPayload({ code: '200', data: { resultCode: -516 } }), false);
  check('const-risk-cooldown', RISK_COOLDOWN_SEC, 7200);
  check('const-risk-explain', RISK_EXPLAIN, 'SCORE_REFUSE');
  check('unwrap-nested', unwrapNested({ resultCode: -516, msg: 'x', data: null }).resultCode, '-516');
  check('unwrap-plain', unwrapNested(2).data, 2);
  check('unwrap-plain-null', unwrapNested(null).data, null);

  // 5) 常量与门槛文案
  check('const-task-id', DEFAULT_TASK_ID, 3157);
  check('const-channel', DEFAULT_CHANNEL_NO, 'P00000112150');
  check('const-activities', DEFAULT_ACTIVITIES.map((a) => [a.id, a.gateDays]), [[17788, 2], [17789, 3], [17790, 3]]);
  check('gate-met', describeGate({ gateDays: 2 }, 2), '已满足累计 2 天');
  check('gate-unmet', describeGate({ gateDays: 3 }, 2), '需累计 3 天，当前 2 天');
  check('gate-unknown', describeGate({ gateDays: 3 }, null), '需累计 3 天');
  check('gate-zero', describeGate({ gateDays: 0 }, 2), '');
  check('date-shanghai', todayShanghai(new Date('2026-11-25T16:30:00Z')), '2026-11-26');
  check('date-shanghai-utc', todayShanghai(new Date('2026-11-25T15:59:00Z')), '2026-11-25');

  // 6) 主流程：signToday=true 不发 sign；residue=0 不发 lottery（只有 17790 有 1 次）
  const calls = [];
  const fakeOk = (req) => {
    calls.push(req.path);
    if (req.path === 'task/getTaskSignInfo') {
      return reply({
        resultCode: 0, msg: 'success',
        data: {
          taskId: 3157, accumulateCount: 2, signToday: true, pushStatus: 0, limitCount: false,
          skuList: [{ signDays: 2, skuId: 96260, awardName: '100MB流量券' }],
        },
      });
    }
    if (req.path === 'lottery/residueLotteryCount') {
      const n = JSON.parse(req.body).activityId === 17790 ? 1 : 0;
      return reply({ code: '200', msg: '操作成功', data: n, success: true });
    }
    if (req.path === 'lottery/lottery') {
      return reply({ code: '200', msg: '操作成功', data: { prizeName: '66 元话费兑换券' }, success: true });
    }
    throw new Error(`自检未覆盖的接口: ${req.path}`);
  };
  const cfg = makeTestCfg();
  const rep = await runAccount(fakeAccount(5), 0, cfg,
    authDeps(fakeOk));
  check('run-signinfo-called', calls.filter((p) => p === 'task/getTaskSignInfo').length, 1);
  check('run-no-sign-when-signed', calls.filter((p) => p === 'task/sign').length, 0);
  check('run-residue-called-3', calls.filter((p) => p === 'lottery/residueLotteryCount').length, 4);
  // ↑ 4 = 凭证探针 1 次 + 三个活动各 1 次。探针**不复用**给正式查询（见 probeCredential 注释：
  //   探针跑在签到前，签到后次数何时到账未实测，复用会把刚获得的机会误判成 0 次）
  check('run-residue0-no-draw', calls.filter((p) => p === 'lottery/lottery').length, 1);
  check('run-prize', rep.prizes.length, 1);
  checkTrue('run-prize-name', String(rep.prizes[0] || '').includes('66 元话费兑换券'));
  check('run-sign-state', rep.signState, 'already');
  check('run-not-failed', rep.failed, false);
  // 用可选链取值：这样变异测试只会得到干净的 FAIL，不会让自检本身抛异常
  check('run-draws-settled', cfg.state.accounts[FAKE_MASK]?.draws?.['17788']?.settlement, 'empty');
  check('run-draws-won', cfg.state.accounts[FAKE_MASK]?.draws?.['17790']?.settlement, 'won');
  checkTrue('run-sign-award', rep.lines.some((l) => l.includes('100MB流量券')));
  // S1：第 2 日起的档位奖励**不是**签到直发（契约 §5.1「第 2 天起请到兑换专区抽取」），
  // 只要文案里出现「自动进卡包」就是对用户的误导。
  check('run-sign-award-not-auto', rep.lines.some((l) => l.includes('自动进卡包，无需领券')), false);
  checkTrue('run-sign-award-day2-wording',
    rep.lines.some((l) => l.includes('签到档位（第 2 日）：100MB流量券') && l.includes('兑换专区')));
  // gateDays 必须真的驱动文案（不只存在于常量表）：累计 2 天时，第3日抽奖应说「需累计 3 天」
  checkTrue('run-gate-text', rep.lines.some((l) => l.includes('第3日抽奖：无抽奖次数（需累计 3 天，当前 2 天）')));
  checkTrue('run-gate-text-met', rep.lines.some((l) => l.includes('第2日抽奖：无抽奖次数（已满足累计 2 天）')));

  // 6b) 「不知道」≠「没有」：residue 的 data 为 null 时必须判契约异常，不能降级成「0 次」
  {
    const hitsBad = [];
    const fakeNullCount = (req) => {
      hitsBad.push(req.path);
      if (req.path === 'task/getTaskSignInfo') {
        return reply({ resultCode: 0, data: { accumulateCount: 2, signToday: true, skuList: [] } });
      }
      if (req.path === 'lottery/residueLotteryCount') return reply({ code: '200', msg: '操作成功', data: null, success: true });
      throw new Error(`自检未覆盖的接口: ${req.path}`);
    };
    const repBad = await runAccount(fakeAccount(12), 0,
      makeTestCfg(), authDeps(fakeNullCount));
    check('residue-null-failed', repBad.failed, true);
    check('residue-null-no-draw', hitsBad.filter((p) => p === 'lottery/lottery').length, 0);
    check('residue-null-not-empty', repBad.lines.some((l) => l.includes('无抽奖次数')), false);
  }
  check('sign-award-null-count', findSignAward([{ signDays: 2, awardName: 'x' }], null), null);
  check('sign-award-null-empty', findSignAward([{ signDays: 2, awardName: 'x' }], ''), null);
  check('sign-award-hit', findSignAward([{ signDays: '2', awardName: '虚构日包' }], 2),
    { name: '虚构日包', signDays: 2 });
  check('sign-award-day1', findSignAward([{ signDays: 1, awardName: '2GB流量日包' }], 1),
    { name: '2GB流量日包', signDays: 1 });

  // 7) 通知自洽：成功/无次数不得命中失效分流；凭证类必须命中；失败必带手动重跑命令
  const okNotice = buildNotice([rep], cfg);
  const okAll = `${okNotice.title}\n${okNotice.content}`;
  check('notice-success-no-alert', matchesAlertRouting(okAll), false);
  checkTrue('notice-success-verdict', okNotice.title.includes('抽中 1 项'));

  const credRep = {
    tag: `账号1(${FAKE_MASK})`, masked: FAKE_MASK, kind: KIND.CREDENTIAL,
    signState: 'none', accumulateCount: null, prizes: [], failed: false, invalid: true,
    lines: [`❌ 签到凭证不可用（code=40）：${MSG_NEED_RELOGIN}`, ...REFETCH_HOWTO],
  };
  const credNotice = buildNotice([credRep], cfg);
  const credAll = `${credNotice.title}\n${credNotice.content}`;
  check('notice-cred-alert', matchesAlertRouting(credAll), true);
  checkTrue('notice-cred-rerun', credAll.includes(RERUN_CMD));
  check('notice-cred-no-leak', credAll.includes(FAKE), false);
  checkTrue('notice-cred-kept', credAll.includes('签到凭证不可用') && credAll.includes('重新登录'));

  const netRep = {
    tag: `账号1(${FAKE_MASK})`, masked: FAKE_MASK, kind: 'error',
    signState: 'none', accumulateCount: null, prizes: [], failed: true, invalid: false,
    lines: ['❌ 查签到状态失败（网络层）: 请求失败: 超时 15000ms'],
  };
  const netNotice = buildNotice([netRep], cfg);
  const netAll = `${netNotice.title}\n${netNotice.content}`;
  check('notice-net-no-alert', matchesAlertRouting(netAll), false);
  checkTrue('notice-net-rerun', netAll.includes(RERUN_CMD));
  check('notice-config-missing-no-alert', matchesAlertRouting(`${TASK_TITLE} ❌ 未配置\n${MSG_MISSING}`), false);

  const taskGoneRep = {
    tag: `账号1(${FAKE_MASK})`, masked: FAKE_MASK, kind: KIND.TASK_GONE,
    signState: 'none', accumulateCount: null, prizes: [], failed: true, invalid: false,
    lines: ['❌ 查签到状态失败：任务不存在（resultCode=-1118）—— taskId 可能随批次变更，改 SANRI_TASK_ID'],
  };
  check('notice-taskgone-no-alert', matchesAlertRouting(buildNotice([taskGoneRep], cfg).content), false);

  // 8) 状态文件：当天完成判定、日期切换、error 不算结论、落盘往返
  const actList = cfg.activities;
  const stEntry = { date: todayShanghai(), signDone: true, drawsDate: todayShanghai(), draws: {} };
  check('state-no-draws-not-done', isDayComplete(stEntry, todayShanghai(), actList), false);
  for (const a of actList) stEntry.draws[String(a.id)] = { settlement: 'empty' };
  check('state-all-settled-done', isDayComplete(stEntry, todayShanghai(), actList), true);
  check('state-other-day-not-done', isDayComplete(stEntry, '2026-11-01', actList), false);
  stEntry.draws['17790'] = { settlement: 'error' };
  check('state-error-not-done', isDayComplete(stEntry, todayShanghai(), actList), false);
  check('state-unsigned-not-done', isDayComplete({ date: todayShanghai(), signDone: false, draws: stEntry.draws }, todayShanghai(), actList), false);

  const tmpState = path.join(os.tmpdir(), `sanri-selfcheck-${process.pid}.json`);
  const st = emptyState();
  const e1 = accountState(st, FAKE_MASK);
  e1.date = todayShanghai(); e1.signDone = true; e1.draws = { 17790: { settlement: 'won', prize: '虚构券' } };
  writeMask(st, 'fp-roundtrip', FAKE_MASK);
  mintState(st, 'fp-roundtrip').count = 2;
  saveState(tmpState, st);
  const reloaded = loadState(tmpState);
  check('state-roundtrip-key', Object.keys(reloaded.accounts), [FAKE_MASK]);
  check('state-roundtrip-prize', accountState(reloaded, FAKE_MASK).draws?.['17790']?.prize, '虚构券');
  check('state-roundtrip-mask', readMask(reloaded, 'fp-roundtrip'), FAKE_MASK);
  check('state-roundtrip-mint', num(mintState(reloaded, 'fp-roundtrip').count, 0), 2);
  check('state-missing-mask', readMask(emptyState(), 'nope'), '');
  check('state-missing-file', Object.keys(loadState(path.join(os.tmpdir(), `sanri-nope-${process.pid}.json`)).accounts), []);
  if (fs.existsSync(tmpState)) fs.unlinkSync(tmpState);

  // 9) 幂等跳过：当天已完成 → 零请求（**连现签都不发**）
  // 状态键是 mobileMask（登录后才知道），所以靠 fp → mobileMask 索引在登录前定位条目；
  // 索引缺失时就必须先现签 —— 那条路径由下面的「无索引」夹具单独覆盖。
  const stDone = emptyState();
  writeMask(stDone, fakeAccount(9).fp, FAKE_MASK);
  const doneEntry = accountState(stDone, FAKE_MASK);
  doneEntry.date = todayShanghai();
  doneEntry.signDone = true;
  doneEntry.drawsDate = todayShanghai();
  doneEntry.draws = {};
  for (const a of actList) doneEntry.draws[String(a.id)] = { settlement: 'empty' };
  let idempotentHits = 0;
  const d9 = authDeps(() => { idempotentHits += 1; throw new Error('不应发请求'); });
  const repSkip = await runAccount(fakeAccount(9), 0, makeTestCfg({ state: stDone }), d9);
  check('idempotent-zero-requests', idempotentHits, 0);
  check('idempotent-zero-mint-login', d9.seen, []);
  check('idempotent-kind', repSkip.kind, 'skipped_today');
  check('idempotent-not-failed', repSkip.failed, false);
  check('idempotent-tag-mask', repSkip.tag, `账号1(${FAKE_MASK})`);

  // 9b) 没有 fp→mask 索引（首跑/换号）→ 必须先现签才知道状态键；状态里没今天的结论就照常干
  {
    const d = authDeps((req) => {
      if (req.path === 'lottery/residueLotteryCount') return reply({ code: '200', data: 0, success: true });
      if (req.path === 'task/getTaskSignInfo') {
        return reply({ resultCode: 0, data: { accumulateCount: 2, signToday: true, skuList: [] } });
      }
      throw new Error(`自检未覆盖的接口: ${req.path}`);
    });
    const cfgNoMask = makeTestCfg();
    const rep = await runAccount(fakeAccount(2), 0, cfgNoMask, d);
    check('nomask-mint-login-once', d.seen, ['mint', 'login']);
    check('nomask-state-written', readMask(cfgNoMask.state, fakeAccount(2).fp), FAKE_MASK);
    check('nomask-not-skipped', rep.kind === 'skipped_today', false);
  }

  // 10) signToday=null（字段缺失）→ 不发 sign、判失败
  checkNull: {
    const hits = [];
    const repNull = await runAccount(fakeAccount(6), 0,
      makeTestCfg(),
      authDeps((req) => { hits.push(req.path); return reply({ resultCode: 0, msg: 'success', data: { accumulateCount: 2 } }); }));
    check('signnull-no-sign', hits.filter((p) => p === 'task/sign').length, 0);
    check('signnull-failed', repNull.failed, true);
  }

  // 11) signToday=false → 发一次 sign；**回读复核**通过才算成功；抽奖次数不足不发 lottery
  {
    const hits = [];
    let signedFlag = false;
    const fakeSign = (req) => {
      hits.push(req.path);
      if (req.path === 'task/getTaskSignInfo') {
        return reply({
          resultCode: 0,
          data: {
            accumulateCount: signedFlag ? 2 : 1, signToday: signedFlag,
            skuList: [{ signDays: 2, awardName: '100MB流量券' }],
          },
        });
      }
      if (req.path === 'task/sign') { signedFlag = true; return reply({ resultCode: 0, msg: 'success', data: null }); }
      if (req.path === 'lottery/residueLotteryCount') return reply({ code: '200', data: 0, success: true });
      throw new Error(`自检未覆盖的接口: ${req.path}`);
    };
    const cfg11 = makeTestCfg();
    const rep11 = await runAccount(fakeAccount(7), 0, cfg11,
      authDeps(fakeSign));
    check('sign-false-sends-sign', hits.filter((p) => p === 'task/sign').length, 1);
    check('sign-false-state', rep11.signState, 'signed');
    check('sign-false-accumulate', rep11.accumulateCount, 2);   // 来自回读，不是无脑 +1
    check('sign-false-verified-read', hits.filter((p) => p === 'task/getTaskSignInfo').length, 2);
    check('sign-false-not-failed', rep11.failed, false);
    check('sign-false-signed-line', rep11.lines.some((l) => l.includes('已回读复核')), true);
    check('sign-false-no-draw', hits.filter((p) => p === 'lottery/lottery').length, 0);
    check('sign-false-done', cfg11.state.accounts[FAKE_MASK]?.signDone, true);
  }

  // 11b) 写接口空转：sign 返回成功但回读始终 signToday=false → 必须判失败（不许冒充成功）
  {
    const hits = [];
    const fakeIdle = (req) => {
      hits.push(req.path);
      if (req.path === 'task/getTaskSignInfo') {
        return reply({ resultCode: 0, data: { accumulateCount: 1, signToday: false, skuList: [] } });
      }
      if (req.path === 'task/sign') return reply({ resultCode: 0, msg: 'success', data: null });
      if (req.path === 'lottery/residueLotteryCount') return reply({ code: '200', data: 0, success: true });
      throw new Error(`自检未覆盖的接口: ${req.path}`);
    };
    const cfgIdle = makeTestCfg();
    const repIdle = await runAccount(fakeAccount(15), 0, cfgIdle,
      authDeps(fakeIdle));
    check('idle-sign-failed', repIdle.failed, true);
    check('idle-sign-state', repIdle.signState, 'signed');
    check('idle-sign-not-done', cfgIdle.state.accounts[FAKE_MASK]?.signDone, false);
    check('idle-sign-line', repIdle.lines.some((l) => l.includes('疑似空转')), true);
    check('idle-sign-verify-reads', hits.filter((p) => p === 'task/getTaskSignInfo').length, 1 + SIGN_VERIFY_ATTEMPTS);
  }

  // 12) 只读模式：**仍然现签**（①+② 是本次要验证的东西），但不发任何写接口、不落状态文件
  {
    const hits = [];
    const fakeDry = (req) => {
      hits.push(req.path);
      if (req.path === 'task/getTaskSignInfo') return reply({ resultCode: 0, data: { accumulateCount: 1, signToday: false, skuList: [] } });
      if (req.path === 'lottery/residueLotteryCount') return reply({ code: '200', data: 2, success: true });
      throw new Error(`只读模式不该发写请求: ${req.path}`);
    };
    const dryStateFile = path.join(os.tmpdir(), `sanri-selfcheck-dryrun-${process.pid}.json`);
    if (fs.existsSync(dryStateFile)) fs.unlinkSync(dryStateFile);
    const cfgDry = makeTestCfg({ dryRun: true, stateFile: dryStateFile });
    const dDry = authDeps(fakeDry);
    const repDry = await runAccount(fakeAccount(8), 0, cfgDry, dDry);
    check('dryrun-mint-login-once', dDry.seen, ['mint', 'login']);   // ①+② 各一次（要验证的就是它）
    check('dryrun-no-sign', hits.filter((p) => p === 'task/sign').length, 0);
    check('dryrun-no-lottery', hits.filter((p) => p === 'lottery/lottery').length, 0);
    check('dryrun-line', repDry.lines.some((l) => l.includes('只读模式')), true);
    check('dryrun-no-state-write', Object.keys(cfgDry.state.accounts).length, 0);
    check('dryrun-no-mask-cache', readMask(cfgDry.state, fakeAccount(8).fp), '');
    check('dryrun-no-state-file', fs.existsSync(dryStateFile), false);
    // 只读模式下 token 仍然被用上了（探针 + 只读查询都带 phone 头）—— 见 25) 的断言
    check('dryrun-read-only-queries', hits.filter((p) => p === 'lottery/residueLotteryCount').length, 4);
  }

  // 12b) 二次嵌套的凭证失效：residue 带内层 -516 → 判凭证类、不发抽奖；抽奖带内层 -516 → 不得当成功
  {
    // ⚠️ 探针是**本账号第一次** residueLotteryCount（每次 runAccount 只发一次），让它回标量
    //    「凭证活」，后面各活动的正式查询再回嵌套 -516 —— 这样两个层次同时被测到：
    //    探针不误判 + runDraws 自身的嵌套处理不误判。
    const hitsCred = [];
    let residueSeen = 0;
    const fakeNestedCred = (req) => {
      hitsCred.push(req.path);
      if (req.path === 'task/getTaskSignInfo') {
        return reply({ resultCode: 0, data: { accumulateCount: 2, signToday: true, skuList: [] } });
      }
      if (req.path === 'lottery/residueLotteryCount') {
        residueSeen += 1;
        return residueSeen === 1
          ? reply({ code: '200', msg: '操作成功', data: 0, success: true })   // 探针：凭证活
          : reply(NESTED_CRED);
      }
      throw new Error(`自检未覆盖的接口: ${req.path}`);
    };
    const repNested = await runAccount(fakeAccount(13), 0,
      makeTestCfg(), authDeps(fakeNestedCred));
    check('nested-residue-probe-passed', residueSeen >= 2, true);
    check('nested-residue-cred', repNested.invalid, true);
    check('nested-residue-no-draw', hitsCred.filter((p) => p === 'lottery/lottery').length, 0);
    check('nested-residue-not-ok', repNested.failed, false);

    const hitsDraw = [];
    const fakeNestedDraw = (req) => {
      hitsDraw.push(req.path);
      if (req.path === 'task/getTaskSignInfo') {
        return reply({ resultCode: 0, data: { accumulateCount: 2, signToday: true, skuList: [] } });
      }
      if (req.path === 'lottery/residueLotteryCount') return reply({ code: '200', data: 1, success: true });
      if (req.path === 'lottery/lottery') return reply(NESTED_CRED);
      throw new Error(`自检未覆盖的接口: ${req.path}`);
    };
    const repNestedDraw = await runAccount(fakeAccount(14), 0,
      makeTestCfg(), authDeps(fakeNestedDraw));
    // ⚠️ 关键：外层 code:200 绝不能被当成「中奖」写给用户
    check('nested-draw-not-won', repNestedDraw.prizes.length, 0);
    check('nested-draw-invalid', repNestedDraw.invalid, true);
    check('nested-draw-settled-error', repNestedDraw.failed, false);
    check('nested-draw-called-once', hitsDraw.filter((p) => p === 'lottery/lottery').length, 1);
  }

  // 12c) 凭证探针（只读 residueLotteryCount）：死凭证 → 零写请求、不落 signDone。
  //    夹具是 research/sanri-contract.md §3.6 的实测响应（外层 code:"200"+success:true，
  //    内层 data.resultCode:-516）。断言的是「探针看到它就不再做任何事」。
  {
    const hits = [];
    const fakeProbeDead = (req) => {
      hits.push(req.path);
      if (req.path === 'lottery/residueLotteryCount') return reply(NESTED_CRED);
      throw new Error(`凭证探针判定失效后不该再发请求: ${req.path}`);
    };
    const cfgProbe = makeTestCfg();
    const repProbe = await runAccount(fakeAccount(16), 0, cfgProbe,
      authDeps(fakeProbeDead));
    check('probe-dead-only-one-read', hits, ['lottery/residueLotteryCount']);   // 零写请求 = 只有探针那一次
    check('probe-dead-no-sign', hits.filter((p) => p === 'task/sign').length, 0);
    check('probe-dead-no-draw', hits.filter((p) => p === 'lottery/lottery').length, 0);
    check('probe-dead-no-getsigninfo', hits.filter((p) => p === 'task/getTaskSignInfo').length, 0);
    check('probe-dead-invalid', repProbe.invalid, true);
    check('probe-dead-kind', repProbe.kind, KIND.CREDENTIAL);
    check('probe-dead-not-failed', repProbe.failed, false);
    check('probe-dead-sign-not-done', Boolean(cfgProbe.state.accounts[FAKE_MASK]?.signDone), false);
    // 跨日重置会把 accumulateCountAfter 置 null（不是 undefined），用 numOrNull 断言「没有数值」
    check('probe-dead-no-accumulate', numOrNull(cfgProbe.state.accounts[FAKE_MASK]?.accumulateCountAfter), null);
    // 「不落状态文件」的准确含义：不写 date / signDone / draws（只保留 credFails 连续计数，与既有凭证分支一致）
    check('probe-dead-no-date', cfgProbe.state.accounts[FAKE_MASK]?.date, undefined);
    // 跨日重置会先把 draws 置成 {}，所以断言「没有任何结论」，而不是「draws 这个 key 不存在」
    check('probe-dead-no-draws', Object.keys(cfgProbe.state.accounts[FAKE_MASK]?.draws || {}).length, 0);
    check('probe-dead-line', repProbe.lines.some((l) => l.includes('凭证探针')), true);
    check('probe-dead-not-zero-line', repProbe.lines.some((l) => l.includes('无抽奖次数')), false);
    check('probe-dead-not-signed-line', repProbe.lines.some((l) => l.includes('签到成功') || l.includes('已签到')), false);
    const probeNotice = buildNotice([repProbe], cfgProbe);
    check('probe-dead-notice-alert', matchesAlertRouting(`${probeNotice.title}\n${probeNotice.content}`), true);
    checkTrue('probe-dead-notice-rerun', probeNotice.content.includes(RERUN_CMD));
  }

  // 12d) 探针通过但 task/sign 回 -516：必须判凭证类失败，绝不能报「签到成功」，且不再抽奖
  {
    const hits = [];
    const fakeSignCred = (req) => {
      hits.push(req.path);
      if (req.path === 'lottery/residueLotteryCount') return reply({ code: '200', msg: '操作成功', data: 0, success: true });
      if (req.path === 'task/getTaskSignInfo') {
        return reply({ resultCode: 0, data: { accumulateCount: 1, signToday: false, skuList: [] } });
      }
      if (req.path === 'task/sign') return reply({ resultCode: -516, msg: '用户未登录或登录已失效', data: null });
      throw new Error(`签到判凭证失效后不该再发请求: ${req.path}`);
    };
    const cfgSignCred = makeTestCfg();
    const repSignCred = await runAccount(fakeAccount(17), 0, cfgSignCred,
      authDeps(fakeSignCred));
    check('sign-cred-invalid', repSignCred.invalid, true);
    check('sign-cred-kind', repSignCred.kind, KIND.CREDENTIAL);
    check('sign-cred-not-failed', repSignCred.failed, false);
    check('sign-cred-no-success-line', repSignCred.lines.some((l) => l.includes('签到成功')), false);
    check('sign-cred-no-draw', hits.filter((p) => p === 'lottery/lottery').length, 0);
    check('sign-cred-no-verify-read', hits.filter((p) => p === 'task/getTaskSignInfo').length, 1); // 只有首读，没有回读
    check('sign-cred-sign-not-done', Boolean(cfgSignCred.state.accounts[FAKE_MASK]?.signDone), false);
    check('sign-cred-fails', cfgSignCred.state.accounts[FAKE_MASK]?.credFails, 1);
  }

  // 12e) 探针返回标量 0（凭证活）后签到成功 → **仍必须**回读复核（探针不得替代写接口复核）
  {
    const hits = [];
    let signedFlag = false;
    const fakeProbeAlive = (req) => {
      hits.push(req.path);
      if (req.path === 'lottery/residueLotteryCount') return reply({ code: '200', msg: '操作成功', data: 0, success: true });
      if (req.path === 'task/getTaskSignInfo') {
        return reply({ resultCode: 0, data: { accumulateCount: signedFlag ? 2 : 1, signToday: signedFlag, skuList: [] } });
      }
      if (req.path === 'task/sign') { signedFlag = true; return reply({ resultCode: 0, msg: 'success', data: null }); }
      throw new Error(`自检未覆盖的接口: ${req.path}`);
    };
    const cfgVerify = makeTestCfg();
    const repVerify = await runAccount(fakeAccount(18), 0, cfgVerify,
      authDeps(fakeProbeAlive));
    check('probe-alive-signinfo-reads', hits.filter((p) => p === 'task/getTaskSignInfo').length, 2); // 首读 + 回读
    check('probe-alive-sign-state', repVerify.signState, 'signed');
    check('probe-alive-verified-line', repVerify.lines.some((l) => l.includes('已回读复核')), true);
    check('probe-alive-not-failed', repVerify.failed, false);
    check('probe-alive-sign-done', cfgVerify.state.accounts[FAKE_MASK]?.signDone, true);
  }

  // 12f) 探针**网络失败** ≠ 凭证死：不得中止，签到照走（写接口自己还有网络分支）
  {
    const hits = [];
    let signInfoSeen = false;
    const fakeProbeNet = (req) => {
      hits.push(req.path);
      // 用「是否已经读过 getTaskSignInfo」区分探针（探针永远在签到流程之前）与正式查询：
      // 这样即使有人删掉探针，本夹具也只会得到干净的 FAIL，而不是让自检自己抛异常。
      if (req.path === 'lottery/residueLotteryCount') {
        if (!signInfoSeen) throw new SanriError(KIND.NETWORK, '模拟探针超时');
        return reply({ code: '200', msg: '操作成功', data: 0, success: true });
      }
      if (req.path === 'task/getTaskSignInfo') {
        signInfoSeen = true;
        return reply({ resultCode: 0, data: { accumulateCount: 2, signToday: true, skuList: [] } });
      }
      throw new Error(`自检未覆盖的接口: ${req.path}`);
    };
    const cfgProbeNet = makeTestCfg();
    const repProbeNet = await runAccount(fakeAccount(19), 0, cfgProbeNet,
      authDeps(fakeProbeNet));
    check('probe-net-not-invalid', repProbeNet.invalid, false);
    check('probe-net-kept-going', hits.filter((p) => p === 'task/getTaskSignInfo').length, 1);
    check('probe-net-sign-state', repProbeNet.signState, 'already');
    check('probe-net-not-failed', repProbeNet.failed, false);
  }

  // 13) 凭证类失败：不计「今日完成」，且连续失败计数会累加
  //    （注：现在 -40 会被探针先命中，但仍必须走同一个凭证通道）
  {
    const cfgCred = makeTestCfg();
    const fakeCred = () => reply({ code: '40', msg: '无权限', success: false });
    const repCred = await runAccount(fakeAccount(10), 0, cfgCred,
      authDeps(fakeCred));
    check('cred-invalid', repCred.invalid, true);
    check('cred-not-failed-flag', repCred.failed, false);
    check('cred-fails-count', cfgCred.state.accounts[FAKE_MASK]?.credFails, 1);
    check('cred-hint-day1', credentialHint({ credFails: 1 }).includes('第 1 天失败'), true);
    check('cred-hint-day2', credentialHint({ credFails: 2 }).includes('已连续 2 天'), true);
    const credNotice2 = buildNotice([repCred], cfgCred);
    check('cred-notice-alert', matchesAlertRouting(`${credNotice2.title}\n${credNotice2.content}`), true);
    checkTrue('cred-notice-rerun', credNotice2.content.includes(RERUN_CMD));
    checkTrue('cred-notice-howto', credNotice2.content.includes('10086.cn'));
  }

  // 14) 签到网络失败**不中断抽奖**（抽奖次数是独立的，漏掉更亏）
  {
    const hits = [];
    const fakeSignNet = (req) => {
      hits.push(req.path);
      if (req.path === 'task/getTaskSignInfo') {
        return reply({ resultCode: 0, data: { accumulateCount: 2, signToday: false, skuList: [] } });
      }
      if (req.path === 'task/sign') throw new SanriError(KIND.NETWORK, '模拟超时');
      if (req.path === 'lottery/residueLotteryCount') {
        return reply({ code: '200', data: JSON.parse(req.body).activityId === 17790 ? 1 : 0, success: true });
      }
      if (req.path === 'lottery/lottery') return reply({ code: '200', data: { awardName: '虚构奖励' }, success: true });
      throw new Error(`自检未覆盖的接口: ${req.path}`);
    };
    const repNet = await runAccount(fakeAccount(11), 0,
      makeTestCfg(), authDeps(fakeSignNet));
    check('sign-net-failure-still-draws', hits.filter((p) => p === 'lottery/lottery').length, 1);
    check('sign-net-failure-failed', repNet.failed, true);
    check('sign-net-failure-prize', repNet.prizes.length, 1);
  }

  // ---- 16) B1 跨日：昨天（或更早）的结论不得参与今天的任何判定 --------------
  // 这两个夹具是 B1 的回归网：变异测试里删掉任一处日期守卫都会让它们转红。
  // 场景一：昨天三个活动都是 empty（0 次），今天服务端各回 1 次 → 必须真的各抽一次。
  {
    const yesterday = '2020-01-01';
    const masked = FAKE_MASK;
    const stCross = emptyState();
    const crossEntry = accountState(stCross, masked);
    crossEntry.date = yesterday;
    crossEntry.signDone = true;
    crossEntry.drawsDate = yesterday;
    crossEntry.draws = {};
    for (const a of actList) {
      crossEntry.draws[String(a.id)] = { settlement: 'empty', count: 0, prize: null, detail: '无抽奖次数' };
    }

    const hitsCross = [];
    const fakeCross = (req) => {
      hitsCross.push(req.path);
      if (req.path === 'lottery/residueLotteryCount') {
        return reply({ code: '200', msg: '操作成功', data: 1, success: true });
      }
      if (req.path === 'task/getTaskSignInfo') {
        return reply({ resultCode: 0, data: { accumulateCount: 3, signToday: true, skuList: [] } });
      }
      if (req.path === 'lottery/lottery') {
        return reply({ code: '200', msg: '操作成功', data: { prizeName: '2元话费兑换券' }, success: true });
      }
      throw new Error(`自检未覆盖的接口: ${req.path}`);
    };
    const cfgCross = makeTestCfg({ state: stCross });
    const repCross = await runAccount(fakeAccount(20), 0, cfgCross,
      authDeps(fakeCross));
    // 探针 1 次 + 三个活动各 1 次 = 4
    check('crossday-residue-queries', hitsCross.filter((p) => p === 'lottery/residueLotteryCount').length, 4);
    check('crossday-draws-3', hitsCross.filter((p) => p === 'lottery/lottery').length, 3);
    check('crossday-all-won', repCross.prizes.length, 3);
    check('crossday-not-skipped', repCross.lines.some((l) => l.includes('今日已有结论')), false);
    check('crossday-draws-date-state', cfgCross.state.accounts[masked]?.drawsDate, todayShanghai());
    check('crossday-settled-won', cfgCross.state.accounts[masked]?.draws?.['17788']?.settlement, 'won');
  }

  // 场景二：昨天且全完成（signDone=true + draws 全 won）→ 今天仍必须完整跑一遍
  {
    const yesterday = '2020-01-01';
    const masked = FAKE_MASK;
    const stCross2 = emptyState();
    const c2 = accountState(stCross2, masked);
    c2.date = yesterday;
    c2.signDone = true;
    c2.drawsDate = yesterday;
    c2.draws = {};
    for (const a of actList) {
      c2.draws[String(a.id)] = { settlement: 'won', count: 1, prize: '昨天虚构券', detail: '抽中 昨天虚构券' };
    }

    const hitsDone = [];
    let signedFlag = false;
    const fakeCrossDone = (req) => {
      hitsDone.push(req.path);
      if (req.path === 'lottery/residueLotteryCount') return reply({ code: '200', msg: '操作成功', data: 0, success: true });
      if (req.path === 'task/getTaskSignInfo') {
        return reply({ resultCode: 0, data: { accumulateCount: signedFlag ? 2 : 1, signToday: signedFlag, skuList: [] } });
      }
      if (req.path === 'task/sign') { signedFlag = true; return reply({ resultCode: 0, msg: 'success', data: null }); }
      throw new Error(`自检未覆盖的接口: ${req.path}`);
    };
    const cfgCross2 = makeTestCfg({ state: stCross2 });
    const repCross2 = await runAccount(fakeAccount(21), 0, cfgCross2,
      authDeps(fakeCrossDone));
    check('crossday2-sign-sent', hitsDone.filter((p) => p === 'task/sign').length, 1);
    check('crossday2-sign-state', repCross2.signState, 'signed');
    check('crossday2-residue-queries', hitsDone.filter((p) => p === 'lottery/residueLotteryCount').length, 4);
    check('crossday2-not-skipped', repCross2.lines.some((l) => l.includes('今日已有结论')), false);
    check('crossday2-no-yesterday-prize', repCross2.lines.some((l) => l.includes('昨天虚构券')), false);
    check('crossday2-settled-empty', cfgCross2.state.accounts[masked]?.draws?.['17790']?.settlement, 'empty');
  }

  // 场景三（resetForNewDay 的专属回归网）：跨日 + 凭证中途失效（break 分支）→
  // 本轮没被访问到的活动，**不得**把昨天的结论重新盖成今天的 drawsDate。
  // 夹具依赖 resetForNewDay 清空 draws：把这一步删掉，下面两条断言就必须转红。
  {
    const yesterday = '2020-01-01';
    const masked = FAKE_MASK;
    const stBreak = emptyState();
    const b = accountState(stBreak, masked);
    b.date = yesterday;
    b.signDone = true;
    b.drawsDate = yesterday;
    b.draws = {};
    for (const a of actList) {
      b.draws[String(a.id)] = { settlement: 'won', count: 1, prize: '昨天虚构券', detail: '抽中 昨天虚构券' };
    }

    let residueSeen = 0;
    const fakeBreak = (req) => {
      if (req.path === 'task/getTaskSignInfo') {
        return reply({ resultCode: 0, data: { accumulateCount: 3, signToday: true, skuList: [] } });
      }
      if (req.path === 'lottery/residueLotteryCount') {
        residueSeen += 1;
        // 探针（第 1 次）必须回标量，否则会被凭证探针提前中止、根本进不了 runDraws；
        // 之后第一个活动查次数就报凭证失效 → runDraws 立刻 break，后两个活动本轮不被访问。
        return residueSeen === 1
          ? reply({ code: '200', msg: '操作成功', data: 1, success: true })
          : reply(NESTED_CRED);
      }
      throw new Error(`自检未覆盖的接口: ${req.path}`);
    };
    const cfgBreak = makeTestCfg({ state: stBreak });
    await runAccount(fakeAccount(29), 0, cfgBreak,
      authDeps(fakeBreak));
    const after = cfgBreak.state.accounts[masked];
    check('reset-no-yesterday-leak', after?.draws?.['17789'], undefined);
    check('reset-no-yesterday-leak-2', after?.draws?.['17790'], undefined);
    check('reset-date-stamped', after?.drawsDate, todayShanghai());
  }

  // 场景四（runDraws 日期守卫的专属回归网）：旧版本状态文件 —— date 是今天、但 **没有**
  // drawsDate 字段（升级前写的）且里面全是 won。resetForNewDay 只看 entry.date（== 今天）
  // 所以不会清；只有跳过判定里的 `entry.drawsDate === today` 能拦住这些陈旧结论。
  // 把那个日期守卫删掉，下面的「必须各抽一次」就必须转红。
  {
    const masked = FAKE_MASK;
    const stOld = emptyState();
    const o = accountState(stOld, masked);
    o.date = todayShanghai();
    o.signDone = true;
    o.draws = {};   // ← 没有 drawsDate（旧格式）
    for (const a of actList) {
      o.draws[String(a.id)] = { settlement: 'won', count: 1, prize: '旧格式虚构券', detail: '抽中 旧格式虚构券' };
    }

    const hitsOld = [];
    const fakeOld = (req) => {
      hitsOld.push(req.path);
      if (req.path === 'lottery/residueLotteryCount') return reply({ code: '200', msg: '操作成功', data: 1, success: true });
      if (req.path === 'task/getTaskSignInfo') {
        return reply({ resultCode: 0, data: { accumulateCount: 3, signToday: true, skuList: [] } });
      }
      if (req.path === 'lottery/lottery') {
        return reply({ code: '200', msg: '操作成功', data: { prizeName: '100MB流量券' }, success: true });
      }
      throw new Error(`自检未覆盖的接口: ${req.path}`);
    };
    const cfgOld = makeTestCfg({ state: stOld });
    const repOld = await runAccount(fakeAccount(30), 0, cfgOld,
      authDeps(fakeOld));
    check('oldstate-not-complete', hitsOld.filter((p) => p === 'lottery/residueLotteryCount').length, 4);
    check('oldstate-draws-3', hitsOld.filter((p) => p === 'lottery/lottery').length, 3);
    check('oldstate-not-skipped', repOld.lines.some((l) => l.includes('今日已有结论')), false);
    check('oldstate-no-stale-prize', repOld.lines.some((l) => l.includes('旧格式虚构券')), false);
  }


  // ---- 17) 当日变体：签到前查到的「0 次」不能在签到成功后当结论复用 ----------
  // 夹具：今天已有一轮「签到失败但抽奖查过 0 次」的记录 → 签到成功后必须重新查次数。
  // 实现上靠「settlement='empty' 一律不复用、只复用 won」来保证（见 runDraws 的注释）。
  {
    const masked = FAKE_MASK;
    const stToday = emptyState();
    const e = accountState(stToday, masked);
    e.date = todayShanghai();
    e.signDone = false;
    e.drawsDate = todayShanghai();
    e.draws = {};
    for (const a of actList) e.draws[String(a.id)] = { settlement: 'empty', count: 0, detail: '无抽奖次数' };

    const hitsSame = [];
    let signedFlag = false;
    const fakeSameDay = (req) => {
      hitsSame.push(req.path);
      if (req.path === 'lottery/residueLotteryCount') {
        return reply({ code: '200', msg: '操作成功', data: signedFlag ? 1 : 0, success: true });
      }
      if (req.path === 'task/getTaskSignInfo') {
        return reply({ resultCode: 0, data: { accumulateCount: signedFlag ? 2 : 1, signToday: signedFlag, skuList: [] } });
      }
      if (req.path === 'task/sign') { signedFlag = true; return reply({ resultCode: 0, msg: 'success', data: null }); }
      if (req.path === 'lottery/lottery') {
        return reply({ code: '200', msg: '操作成功', data: { prizeName: '100MB流量券' }, success: true });
      }
      throw new Error(`自检未覆盖的接口: ${req.path}`);
    };
    const cfgSame = makeTestCfg({ state: stToday });
    const repSame = await runAccount(fakeAccount(22), 0, cfgSame,
      authDeps(fakeSameDay));
    // 签到后三个活动各回 1 次 → 必须各抽一次（不能被签到前的 0 次拦住）
    check('sameday-draws-3', hitsSame.filter((p) => p === 'lottery/lottery').length, 3);
    check('sameday-not-skipped', repSame.lines.some((l) => l.includes('今日已有结论')), false);
    // 签到前那条 empty 结论必须被重新查（探针 1 + 三活动各 1 = 4）
    check('sameday-requeried', hitsSame.filter((p) => p === 'lottery/residueLotteryCount').length, 4);
    check('sameday-settled-won', cfgSame.state.accounts[masked]?.draws?.['17788']?.settlement, 'won');
  }

  // ---- 18) S8 跳过不得降级记录：原样保留 settlement/count/prize/detail ----------
  // 17788 won（→ 进跳过分支）/ 17789 empty（→ 重新查）/ 17790 error（→ 重新查且一直失败）。
  {
    const masked = FAKE_MASK;
    const stSkip = emptyState();
    const e = accountState(stSkip, masked);
    e.date = todayShanghai();
    e.signDone = true;
    e.drawsDate = todayShanghai();
    e.draws = {
      17788: { settlement: 'won', count: 1, prize: '虚构券', detail: '抽中 虚构券（1 次机会已用 1 次）' },
      17789: { settlement: 'empty', count: 0, prize: null, detail: '无抽奖次数（需累计 3 天，当前 2 天）' },
      17790: { settlement: 'error', count: null, prize: null, detail: '抽奖失败' },
    };
    const hitsSkip = [];
    const fakeSkip = (req) => {
      hitsSkip.push(req.path);
      // residue 的 data 故意给 null（契约异常）→ 17790 每轮都落在 error 结论上，
      // 于是 isDayComplete 永远不成立，第二轮也真的会进 runDraws 的跳过分支（这是我们想测的）。
      if (req.path === 'lottery/residueLotteryCount') {
        // 17790 的 data 故意给 null（契约异常）→ 它每轮都落在 error 结论上，
        // 于是 isDayComplete 永远不成立，第二轮也真的会进 runDraws（这是我们要测的）。
        const id = JSON.parse(req.body).activityId;
        return reply({ code: '200', msg: '操作成功', data: id === 17790 ? null : 0, success: true });
      }
      if (req.path === 'task/getTaskSignInfo') {
        return reply({ resultCode: 0, data: { accumulateCount: 2, signToday: true, skuList: [] } });
      }
      throw new Error(`自检未覆盖的接口: ${req.path}`);
    };
    const cfgSkip = makeTestCfg({ state: stSkip });
    // 跑两次，验证 detail 不会每轮多套一层括号。
    // ⚠️ 第二轮之前必须把现签最小间隔（600s）跳过：否则第二轮会被本地纪律拦成
    //    skipped_throttle（零请求），下面的断言会变成在测「限频」而不是「跳过不降级」。
    await runAccount(fakeAccount(23), 0, cfgSkip, authDeps(fakeSkip));
    mintState(cfgSkip.state, fakeAccount(23).fp).lastTs = Math.floor(Date.now() / 1000) - 3600;
    const afterOne = JSON.parse(JSON.stringify(cfgSkip.state.accounts[masked].draws));
    const repSkip2 = await runAccount(fakeAccount(23), 0, cfgSkip,
      authDeps(fakeSkip));
    const afterTwo = cfgSkip.state.accounts[masked].draws;
    check('skip-won-kept', afterTwo['17788'].settlement, 'won');
    check('skip-count-kept', afterTwo['17788'].count, 1);
    check('skip-prize-kept', afterTwo['17788'].prize, '虚构券');
    check('skip-detail-stable', afterTwo['17788'].detail, afterOne['17788'].detail);
    check('skip-detail-original', afterTwo['17788'].detail, '抽中 虚构券（1 次机会已用 1 次）');
    check('skip-empty-kept', afterTwo['17789'].settlement, 'empty');
    check('skip-empty-detail-stable', afterTwo['17789'].detail, '无抽奖次数（需累计 3 天，当前 2 天）');
    // 2 轮 × (探针 + 17789 + 17790) = 6；17788 是 won 被跳过，不查次数
    check('skip-error-retried', hitsSkip.filter((p) => p === 'lottery/residueLotteryCount').length, 6);
    check('skip-line-once', repSkip2.lines.filter((l) => l.includes('今日已有结论')).length, 1);
    check('skip-not-counted-as-prize', repSkip2.prizes.length, 0);
  }

  // ---- 19) S1 奖励文案：只有第 1 天才能说「自动进卡包」 --------------------
  {
    const mkAwardRun = async (accBefore, accAfter, skuList) => {
      let signedFlag = false;
      const cfgA = makeTestCfg();
      const repA = await runAccount(fakeAccount(24), 0, cfgA,
        authDeps((req) => {
          if (req.path === 'lottery/residueLotteryCount') return reply({ code: '200', data: 0, success: true });
          if (req.path === 'task/getTaskSignInfo') {
            return reply({
              resultCode: 0,
              data: { accumulateCount: signedFlag ? accAfter : accBefore, signToday: signedFlag, skuList },
            });
          }
          if (req.path === 'task/sign') { signedFlag = true; return reply({ resultCode: 0, msg: 'success', data: null }); }
          throw new Error(`自检未覆盖的接口: ${req.path}`);
        }));
      return repA;
    };
    const repDay1 = await mkAwardRun(0, 1, [{ signDays: 1, skuId: 96234, awardName: '2GB流量日包' }]);
    checkTrue('award-day1-auto',
      repDay1.lines.some((l) => l.includes('签到直发（第 1 日）：2GB流量日包') && l.includes('自动进卡包，无需领券')));
    const repDay3 = await mkAwardRun(2, 3, [{ signDays: 3, skuId: 96261, awardName: '第 3 日抽奖资格' }]);
    checkTrue('award-day3-qualification',
      repDay3.lines.some((l) => l.includes('签到档位（第 3 日）：第 3 日抽奖资格') && l.includes('需到「兑换专区」抽取')));
    check('award-day3-not-auto', repDay3.lines.some((l) => l.includes('自动进卡包，无需领券')), false);
  }

  // ---- 20) S5 accumulateCount 缺失时不得回落成 0 --------------------------
  {
    let signedFlag = false;
    const cfgNullAcc = makeTestCfg();
    const repNullAcc = await runAccount(fakeAccount(25), 0, cfgNullAcc,
      authDeps((req) => {
        if (req.path === 'lottery/residueLotteryCount') return reply({ code: '200', data: 0, success: true });
        if (req.path === 'task/getTaskSignInfo') {
          return reply({ resultCode: 0, data: { signToday: signedFlag, skuList: [] } });   // 没有 accumulateCount
        }
        if (req.path === 'task/sign') { signedFlag = true; return reply({ resultCode: 0, msg: 'success', data: null }); }
        throw new Error(`自检未覆盖的接口: ${req.path}`);
      }));
    check('null-acc-stays-null', repNullAcc.accumulateCount, null);
    check('null-acc-state-null', cfgNullAcc.state.accounts[FAKE_MASK]?.accumulateCount, null);
    check('null-acc-no-zero-text', repNullAcc.lines.some((l) => l.includes('累计 0 天') || l.includes('当前 0 天')), false);
    check('num-or-null', [numOrNull(null), numOrNull(''), numOrNull(undefined), numOrNull('3'), numOrNull(0)],
      [null, null, null, 3, 0]);
  }

  // ---- 21) S2 credFails 是「天数」不是「次数」 ---------------------------
  {
    const masked = FAKE_MASK;
    const stSame = emptyState();
    const e = accountState(stSame, masked);
    e.credFails = 1;
    e.lastCredFailDate = todayShanghai();   // 今天已经失败过一次（手动重跑场景）
    const cfgSameDay = makeTestCfg({ state: stSame });
    const repSameDay = await runAccount(fakeAccount(26), 0, cfgSameDay,
      authDeps(() => reply({ code: '40', msg: '无权限', success: false })));
    check('cred-same-day-not-incremented', cfgSameDay.state.accounts[masked]?.credFails, 1);
    check('cred-same-day-hint-day1', repSameDay.lines.some((l) => l.includes('第 1 天失败')), true);
    check('cred-same-day-no-3days', repSameDay.lines.some((l) => l.includes('已连续 3 天')), false);

    const masked2 = FAKE_MASK;
    const stNextDay = emptyState();
    const e2 = accountState(stNextDay, masked2);
    e2.credFails = 1;
    e2.lastCredFailDate = '2020-01-01';     // 上一个失败日不是今天 → 应该 +1
    const cfgNextDay = makeTestCfg({ state: stNextDay });
    const repNextDay = await runAccount(fakeAccount(27), 0, cfgNextDay,
      authDeps(() => reply({ code: '40', msg: '无权限', success: false })));
    check('cred-next-day-incremented', cfgNextDay.state.accounts[masked2]?.credFails, 2);
    check('cred-next-day-hint', repNextDay.lines.some((l) => l.includes('已连续 2 天')), true);
    check('cred-last-date-recorded', cfgNextDay.state.accounts[masked2]?.lastCredFailDate, todayShanghai());
  }

  // ---- 22) S3 回读窗口可配置且默认 6 次 / 2500ms -------------------------
  {
    check('verify-attempts-default', SIGN_VERIFY_ATTEMPTS, 6);
    check('verify-gap-default', SIGN_VERIFY_GAP_MS, 2500);
    const reads = [];
    const waits = [];
    const cfgV = makeTestCfg({ verifyAttempts: 2, verifyMs: 7 });
    await runAccount(fakeAccount(28), 0, cfgV,
      authDeps((req) => {
        if (req.path === 'lottery/residueLotteryCount') return reply({ code: '200', data: 0, success: true });
        if (req.path === 'task/getTaskSignInfo') {
          reads.push(1);
          return reply({ resultCode: 0, data: { accumulateCount: 1, signToday: false, skuList: [] } });
        }
        if (req.path === 'task/sign') return reply({ resultCode: 0, msg: 'success', data: null });
        throw new Error(`自检未覆盖的接口: ${req.path}`);
      }, { sleep: async (ms) => { waits.push(ms); } }));
    check('verify-attempts-respected', reads.length, 1 + 2);   // 首读 + cfg.verifyAttempts
    check('verify-gap-respected', waits, [7]);                // 2 次尝试 = 1 次等待
  }

  // ---- 23) S9 / S10：零通知判定与配置缺失文案的可测试形式 -----------------
  {
    check('all-done-suppresses-notify', allAccountsQuiet([{ kind: 'skipped_today' }, { kind: 'skipped_today' }]), true);
    check('all-done-partial', allAccountsQuiet([{ kind: 'skipped_today' }, { kind: 'done' }]), false);
    check('all-done-empty', allAccountsQuiet([]), false);
    // 现签静默 / 限频跳过也是「安静结束」：不该发一条「全都静默中」的推送
    check('all-quiet-throttle', allAccountsQuiet([{ kind: 'skipped_throttle' }, { kind: 'skipped_today' }]), true);
    check('all-quiet-mixed-fail', allAccountsQuiet([{ kind: 'skipped_throttle' }, { kind: 'error' }]), false);
    const cfgNotice = buildConfigMissingNotice(MSG_MISSING);
    check('config-missing-rerun', cfgNotice.content.includes(`👉 配好后重跑: ${RERUN_CMD}`), true);
    check('config-missing-no-alert', matchesAlertRouting(`${cfgNotice.title}\n${cfgNotice.content}`), false);
  }

  // ---- 24) 现签链路（P0 改造的核心回归网）---------------------------------
  // 24a) login 成功 → 业务请求头 phone **必须**是 login 返回的 data.token，
  //      不能是配置里的任何值（mint.reqBody.cellNum / tel / mint.xk）
  {
    const phones = [];
    const d = authDeps((req) => {
      phones.push(req.headers.phone);
      if (req.path === 'task/getTaskSignInfo') {
        return reply({ resultCode: 0, data: { accumulateCount: 2, signToday: true, skuList: [] } });
      }
      if (req.path === 'lottery/residueLotteryCount') return reply({ code: '200', data: 0, success: true });
      throw new Error(`自检未覆盖的接口: ${req.path}`);
    });
    const cfgTok = makeTestCfg();
    const acc = fakeAccount(31);
    const repTok = await runAccount(acc, 0, cfgTok, d);
    check('token-from-login', [...new Set(phones)], [FAKE_TOKEN]);
    check('token-not-config-value',
      phones.some((p) => p === acc.mint.reqBody.cellNum || p === acc.mint.xk || p === acc.tel), false);
    check('token-registered-secret', redact(`phone=${FAKE_TOKEN}`).includes(FAKE_TOKEN), false);
    // mobileMask 作为显示名：出现在通知里，且完整 token 不出现
    const noticeTok = buildNotice([repTok], cfgTok);
    const allTok = `${noticeTok.title}\n${noticeTok.content}`;
    check('notice-shows-mask', allTok.includes(FAKE_MASK), true);
    check('notice-hides-token', allTok.includes(FAKE_TOKEN), false);
    check('notice-no-alert-on-success', matchesAlertRouting(allTok), false);
    // 状态文件键 = mobileMask（不是 token、不是脱敏 token）
    check('state-key-is-mask', Object.keys(cfgTok.state.accounts), [FAKE_MASK]);
    check('state-no-token-leak', JSON.stringify(cfgTok.state).includes(FAKE_TOKEN), false);
  }

  // 24b) login 返回 40006（ticket 不可用）→ 零业务请求 + 凭证类失败 + 文案说「现签失败」
  {
    let businessHits = 0;
    const d = authDeps(
      () => { businessHits += 1; throw new Error('现签失败后不该发业务请求'); },
      { login: () => reply({ code: '40006', message: '用户信息已过期，请重新访问' }) },
    );
    const cfgLogin = makeTestCfg();
    const repLogin = await runAccount(fakeAccount(32), 0, cfgLogin, d);
    check('login-fail-seen', d.seen, ['mint', 'login']);
    check('login-fail-no-business', businessHits, 0);
    check('login-fail-invalid', repLogin.invalid, true);
    check('login-fail-not-failed-flag', repLogin.failed, false);
    check('login-fail-kind', repLogin.kind, KIND.LOGIN);
    checkTrue('login-fail-wording', repLogin.lines.some((l) => l.includes('现签失败')));
    check('login-fail-not-expired-wording', repLogin.lines.some((l) => l.includes('凭证已失效')), false);
    check('login-fail-no-state', Object.keys(cfgLogin.state.accounts).length, 0);
    const n = buildNotice([repLogin], cfgLogin);
    const allLogin = `${n.title}\n${n.content}`;
    check('login-fail-alert', matchesAlertRouting(allLogin), true);   // 含「重新登录」→ 失效 Bot
    checkTrue('login-fail-rerun', n.content.includes(RERUN_CMD));
    check('login-fail-exit-flag', repLogin.invalid, true);
  }

  // 24c) login code:"0" 但 data.token 缺失 → 契约漂移：零业务请求、fail-closed、不冒充成功
  {
    let businessHits = 0;
    const d = authDeps(
      () => { businessHits += 1; throw new Error('契约漂移后不该发业务请求'); },
      { login: () => reply({ code: '0', message: '成功!', data: { mobileMask: FAKE_MASK } }) },
    );
    const cfgNt = makeTestCfg();
    const repNt = await runAccount(fakeAccount(33), 0, cfgNt, d);
    check('login-no-token-no-business', businessHits, 0);
    check('login-no-token-failed', repNt.failed, true);
    check('login-no-token-kind', repNt.kind, KIND.CONTRACT);
    check('login-no-token-not-invalid', repNt.invalid, false);
    checkTrue('login-no-token-wording', repNt.lines.some((l) => l.includes('不符合契约')));
    checkTrue('login-no-token-line-count', repNt.lines.length === 1);
    const n = buildNotice([repNt], cfgNt);
    check('login-no-token-notice-no-alert', matchesAlertRouting(`${n.title}\n${n.content}`), false);
    checkTrue('login-no-token-notice-rerun', n.content.includes(RERUN_CMD));
  }

  // 24d) mint retCode 214103（登录过于频繁）→ 静默 24h、**不发 login**、不进通知正文
  {
    let businessHits = 0;
    const d = authDeps(
      () => { businessHits += 1; throw new Error('静默期间不该发业务请求'); },
      { mint: () => mintReply('214103', '登录过于频繁') },
    );
    const cfgSilence = makeTestCfg();
    const repSilence = await runAccount(fakeAccount(34), 0, cfgSilence, d);
    check('mint-silence-no-login', d.seen, ['mint']);          // 只发了 ①，没发 ②
    check('mint-silence-no-business', businessHits, 0);
    check('mint-silence-kind', repSilence.kind, 'skipped_throttle');
    check('mint-silence-not-failed', Boolean(repSilence.failed || repSilence.invalid), false);
    const ms = cfgSilence.state.mint[fakeAccount(34).fp];
    check('mint-silence-code', ms && ms.blockedCode, '214103');
    checkTrue('mint-silence-blocked', num(ms && ms.blockedUntil, 0) > Math.floor(Date.now() / 1000) + 86000);
    const n = buildNotice([repSilence], cfgSilence);
    const allSilence = `${n.title}\n${n.content}`;
    check('mint-silence-notice-no-code', allSilence.includes('214103'), false);
    check('mint-silence-notice-no-content', allSilence.includes('风控'), false);
    check('mint-silence-quiet', allAccountsQuiet([repSilence]), true);

    // 静默期内再次运行：连 autoLogin 都不许发（本地纪律，零请求）
    const d2 = authDeps(() => { throw new Error('静默期内不该发任何请求'); });
    const repSilence2 = await runAccount(fakeAccount(34), 0, makeTestCfg({ state: cfgSilence.state }), d2);
    check('mint-silence-no-second-mint', d2.seen, []);
    check('mint-silence-second-kind', repSilence2.kind, 'skipped_throttle');
  }

  // 24e) 两次现签最小间隔 600s（本地纪律）：刚签过就再跑 → 跳过，不发第二个 autoLogin
  {
    const stGap = emptyState();
    mintState(stGap, fakeAccount(35).fp).lastTs = Math.floor(Date.now() / 1000) - 60;
    const d = authDeps(() => { throw new Error('不该发请求'); });
    const repGap = await runAccount(fakeAccount(35), 0, makeTestCfg({ state: stGap }), d);
    check('mint-gap-no-mint', d.seen, []);
    check('mint-gap-kind', repGap.kind, 'skipped_throttle');
    // 2026-11-28 从 600 降到 120：日频 cron 下 10 分钟只会挡住手动补跑（见常量注释）
    check('mint-gap-secs', MINT_MIN_INTERVAL_SEC, 120);
    check('mint-gap-lt-czrhd', MINT_MIN_INTERVAL_SEC < 600, true);
  }

  // 24f) login 返回 403 / 非 JSON → 凭证类 / 未知（都不能当成功）
  {
    check('login-cls-403', classifyLogin({ httpStatus: 403, text: '', json: null }).kind, KIND.CREDENTIAL);
    check('login-cls-nonjson', classifyLogin({ httpStatus: 200, text: '<html>', json: null }).kind, KIND.UNKNOWN);
    check('login-cls-code-empty', classifyLogin({ httpStatus: 200, text: '{}', json: {} }).kind, KIND.LOGIN);
    check('login-cls-ok', classifyLogin(reply({ code: '0', data: { token: 'x' } })).ok, true);
    check('login-cls-no-token', classifyLogin(reply({ code: '0', data: {} })).kind, KIND.CONTRACT);
    check('login-body-fixed', loginBody('T'), {
      ticket: 'T', ticketType: 11, businessType: 'RIGHTS_MARKET',
      wxoaType: '', m1: '', m2: '', s1: '', s2: '', from: '', jsid: 'T',
    });
    check('login-body-ticket-type', loginBody('T').ticketType, LOGIN_TICKET_TYPE);
    // jsid 必须与 ticket 逐字相同：只传 ticket 不传 jsid → 服务端 code=40006（2026-11-26 实测）
    check('login-body-jsid-equals-ticket', loginBody('XYZ').jsid, 'XYZ');
    check('login-body-jsid-same-as-ticket', loginBody('XYZ').jsid === loginBody('XYZ').ticket, true);
  }

  // 24g) ticket 必须是 ① 那条 Set-Cookie 的**完整原值**（不能精简成 JSESSIONID+UID+ticketID）
  {
    let ticketSeen = '';
    const d = authDeps((req) => {
      if (req.path === 'task/getTaskSignInfo') {
        return reply({ resultCode: 0, data: { accumulateCount: 1, signToday: true, skuList: [] } });
      }
      if (req.path === 'lottery/residueLotteryCount') return reply({ code: '200', data: 0, success: true });
      throw new Error(`自检未覆盖的接口: ${req.path}`);
    }, {
      login: (req) => { ticketSeen = JSON.parse(req.body).ticket; return loginReply(); },
    });
    await runAccount(fakeAccount(36), 0, makeTestCfg(), d);
    check('login-ticket-raw', ticketSeen, MINT_TICKET);
    checkTrue('login-ticket-has-comment', ticketSeen.includes('Comment=SessionServer-unity'));
    check('build-ticket-null', buildAppTicket('UID=x; Secure'), null);
    check('build-ticket-raw', buildAppTicket(` ${MINT_TICKET} `), MINT_TICKET);
  }

  // ==== 凭证来源链（本轮新增：token 优先、mint 兜底）=========================
  // 夹具里的 token 一律是**虚构值**（真实 token 不得进源码/自检）。
  const TOK1 = 'SanriFixedTokenAaBbCcDd0123456789';   // ① SANRI_PHONE
  const TOK2 = 'SanriSurgeTokenEeFfGgHh9876543210';   // ② Surge
  registerSecret(TOK1);
  registerSecret(TOK2);
  const tokenAccount = (n, token) => {
    const tel = `13800001${String(n).padStart(3, '0')}`;
    return { tel, fp: `token:#${n}`, mint: null, masked: maskPhone(tel), fixedToken: token, phone: '' };
  };
  // Surge 记录夹具（字段名与实测一致：URL / startDate（秒）/ requestHeader（原始头块））
  const surgeRec = (token, ageSec = 60, host = ORIGIN_HOST) => ({
    URL: `https://${host}/coc3/coc3-market-activity/cmpp-manage/task/getTaskSignInfo`,
    startDate: Math.floor(Date.now() / 1000) - ageSec,
    requestHeader: `POST /coc3/x HTTP/2\r\n:authority: ${host}\r\ncontent-type: application/json\r\nphone: ${token}\r\n`,
  });
  // 业务 stub：只要用到 token 的地方都记下 phone 头；业务码一律“活”
  const aliveStub = (sink) => (req) => {
    sink.push([req.path, req.headers.phone]);
    if (req.path === 'task/getTaskSignInfo') {
      return reply({ resultCode: 0, data: { accumulateCount: 1, signToday: true, skuList: [] } });
    }
    if (req.path === 'lottery/residueLotteryCount') return reply({ code: '200', data: 0, success: true });
    throw new Error(`自检未覆盖的接口: ${req.path}`);
  };

  // 25) SANRI_PHONE 解析：分隔符/保序去重/JSON 形态/非法值；与 mint 账号**按顺序**配对
  {
    const pt = parseTokens(`${TOK1}&${TOK2}\n${TOK1}`);
    check('tokens-count', pt.tokens.length, 2);
    check('tokens-order', pt.tokens.map((t) => t.token.slice(0, 6)), ['SanriF', 'SanriS']);
    check('tokens-problems', pt.problems.length, 0);
    const ptj = parseTokens(JSON.stringify({ phone: TOK1, tel: '13800138000' }));
    check('tokens-json-tel', [ptj.tokens.length, ptj.tokens[0].tel], [1, '13800138000']);
    const ptbad = parseTokens('short&Abc def Ghijklmnopqrst&{"nope":1}');
    check('tokens-bad-dropped', ptbad.tokens.length, 0);
    check('tokens-bad-problems', ptbad.problems.length, 3);
    const merged = parseAccounts(`${accJson(1)}&${accJson(2)}`, pt.tokens);
    check('merge-count', merged.accounts.length, 2);
    check('merge-fixed-order', merged.accounts.map((a) => maskSecret(a.fixedToken)), [maskSecret(TOK1), maskSecret(TOK2)]);
    const oneMint = parseAccounts(accJson(1), pt.tokens);
    check('merge-extra-token-account', oneMint.accounts.length, 2);
    check('merge-extra-token-mask', oneMint.accounts[1].masked, 'phone2');
    check('merge-extra-token-fp', oneMint.accounts[1].fp, 'token:#2');
  }

  // 26) 来源 ①：业务请求带的就是 SANRI_PHONE 的 token，且**不发** mint
  {
    const hit = [];
    const d = authDeps(aliveStub(hit));
    const cfgP = makeTestCfg();
    const acc = tokenAccount(1, TOK1);
    const rep = await runAccount(acc, 0, cfgP, d);
    check('phone-src-no-mint', d.seen, []);
    check('phone-src-header', [...new Set(hit.map((x) => x[1]))], [TOK1]);
    check('phone-src-kind', rep.authSource, 'phone');
    check('phone-src-not-failed', Boolean(rep.failed || rep.invalid), false);
    check('phone-src-state-key', Object.keys(cfgP.state.accounts), [acc.masked]);
    check('phone-src-no-token-in-state', JSON.stringify(cfgP.state).includes(TOK1), false);
  }

  // 26b) 来源 ① 的 token 被探针判死 → 凭证类失败、**零写请求**、**不**退回去试 mint
  {
    const hit = [];
    const d = authDeps((req) => {
      hit.push(req.path);
      if (req.path === 'lottery/residueLotteryCount') return reply(NESTED_CRED);
      throw new Error(`凭证探针判死后不该再发请求: ${req.path}`);
    });
    const cfgP2 = makeTestCfg();
    const repDead = await runAccount(tokenAccount(2, TOK1), 0, cfgP2, d);
    check('phone-src-dead-no-mint', d.seen, []);
    check('phone-src-dead-only-probe', hit, ['lottery/residueLotteryCount']);
    check('phone-src-dead-invalid', repDead.invalid, true);
    check('phone-src-dead-kind', repDead.kind, KIND.CREDENTIAL);
    // 文案要指向「重抓 phone 头」而不是「重抓 mint 模板」
    const notice = buildNotice([repDead], cfgP2);
    const all = `${notice.title}\n${notice.content}`;
    check('phone-src-dead-alert', matchesAlertRouting(all), true);
    checkTrue('phone-src-dead-wording', all.includes('SANRI_PHONE'));
    check('phone-src-dead-no-mint-wording', all.includes('autoLogin'), false);
  }

  // 27) 来源 ②：Surge recent 里的新鲜 token → 用它，不发 mint
  {
    const hit = [];
    const d = authDeps((req) => {
      if (req.path === SURGE_RECENT_PATH) return reply({ requests: [surgeRec(TOK2)] });
      return aliveStub(hit)(req);
    });
    const cfgS = makeTestCfg({ surgeUrl: 'http://127.0.0.1:9', surgeKey: 'k' });
    const repSurge = await runAccount(fakeAccount(40), 0, cfgS, d);
    check('surge-src-no-mint', d.seen, []);
    check('surge-src-header', [...new Set(hit.filter((x) => x[1]).map((x) => x[1]))], [TOK2]);
    check('surge-src-kind', repSurge.authSource, 'surge');
    check('surge-src-not-failed', Boolean(repSurge.failed || repSurge.invalid), false);
  }

  // 27b) recent 里没有（被 App 流量挤出 50 条）→ 会话扫描兜底（实测那条路才稳）
  {
    const hit = [];
    const d = authDeps((req) => {
      if (req.path === SURGE_RECENT_PATH) return reply({ requests: [] });
      if (req.path === SURGE_SESSIONS_PATH) return reply({ sessions: [{ name: 'sess-1', active: true }, { name: 'sess-0' }] });
      if (req.path === SURGE_SESSION_REQUESTS_PATH) {
        checkTrue('surge-session-query', String(req.url || '').includes('name=sess-1')
          && String(req.url || '').includes(encodeURIComponent(ORIGIN_HOST)));
        return reply({ requests: [surgeRec(TOK2, 120)] });
      }
      return aliveStub(hit)(req);
    });
    const repSess = await runAccount(fakeAccount(41), 0,
      makeTestCfg({ surgeUrl: 'http://127.0.0.1:9', surgeKey: 'k' }), d);
    check('surge-session-no-mint', d.seen, []);
    check('surge-session-kind', repSess.authSource, 'surge');
  }

  // 28) Surge 的 token 已超过有效期（默认 25 分钟）→ **不采用**，继续往 mint 走
  {
    const hit = [];
    const d = authDeps((req) => {
      if (req.path === SURGE_RECENT_PATH) return reply({ requests: [surgeRec(TOK2, 26 * 60)] });
      if (req.path === SURGE_SESSIONS_PATH) return reply({ sessions: [] });
      return aliveStub(hit)(req);
    });
    const cfgStale = makeTestCfg({ surgeUrl: 'http://127.0.0.1:9', surgeKey: 'k' });
    const repStale = await runAccount(fakeAccount(42), 0, cfgStale, d);
    check('surge-stale-falls-to-mint', d.seen, ['mint', 'login']);
    check('surge-stale-uses-mint-token', [...new Set(hit.filter((x) => x[1]).map((x) => x[1]))], [FAKE_TOKEN]);
    check('surge-stale-kind', repStale.authSource, 'mint');
    // 纯函数层面再钉一次：25 分钟内的用、25 分钟外的不算
    const fresh = pickPhoneTokens([surgeRec(TOK2, 60)], { nowSec: Math.floor(Date.now() / 1000), maxAgeMin: 25 });
    const stale = pickPhoneTokens([surgeRec(TOK2, 40 * 60)], { nowSec: Math.floor(Date.now() / 1000), maxAgeMin: 25 });
    check('pick-fresh', fresh.tokens.length, 1);
    check('pick-stale', stale.tokens.length, 0);
    check('pick-stale-counted', stale.skippedStale, 1);
  }

  // 29) 非 dev.coc.10086.cn 域名的 phone 头**不得**采用（别的 host 的同名头不是本活动凭证）
  {
    const pure = pickPhoneTokens([surgeRec(TOK2, 60, 'client.app.coc.10086.cn')], { nowSec: Math.floor(Date.now() / 1000) });
    check('pick-other-host', pure.tokens.length, 0);
    check('is-activity-url-yes', isActivityUrl(`https://${ORIGIN_HOST}/coc3/x`), true);
    check('is-activity-url-no', isActivityUrl('https://res.coc.10086.cn/coc3/x'), false);
    // 没有 startDate 的记录不采用（无法判有效期）
    const noTime = pickPhoneTokens([{ URL: `https://${ORIGIN_HOST}/x`, requestHeader: `phone: ${TOK2}` }], {});
    check('pick-no-time', [noTime.tokens.length, noTime.skippedNoTime], [0, 1]);
    // 同一条 token 多次出现只留一个（否则会被当成多账号）
    const dup = pickPhoneTokens([surgeRec(TOK2, 60), surgeRec(TOK2, 30)], {});
    check('pick-dedupe', dup.tokens.length, 1);
    // headerValue 解析：大小写/空白/不误取别的头
    check('header-phone', headerValue('POST /x HTTP/2\r\nPhone:  abc123 \r\n', 'phone'), 'abc123');
    check('header-missing', headerValue('POST /x HTTP/2\r\nx-phone: abc\r\n', 'phone'), '');
  }

  // 30) Surge 网络/接口失败 → **不判账号失败**，告警后降级到 mint
  {
    const hit = [];
    const d = authDeps((req) => {
      if (req.path === SURGE_RECENT_PATH) throw new SanriError(KIND.NETWORK, '模拟 Surge 超时');
      if (req.path === SURGE_SESSIONS_PATH) throw new SanriError(KIND.NETWORK, '模拟 Surge 超时');
      return aliveStub(hit)(req);
    });
    const repNet = await runAccount(fakeAccount(43), 0,
      makeTestCfg({ surgeUrl: 'http://127.0.0.1:9', surgeKey: 'k' }), d);
    check('surge-net-degrades', d.seen, ['mint', 'login']);
    check('surge-net-not-failed', Boolean(repNet.failed || repNet.invalid), false);
    check('surge-net-kind', repNet.authSource, 'mint');
    // surgeTokens 本身**绝不抛**（它是外部依赖，挂了不能拖垮账号）
    const cfgE = makeTestCfg({ surgeUrl: 'http://127.0.0.1:9', surgeKey: 'k' });
    const got = await surgeTokens(cfgE, { request: () => { throw new SanriError(KIND.NETWORK, 'x'); } });
    check('surge-tokens-never-throws', got.tokens, []);
    checkTrue('surge-tokens-reason', String(got.reason).length > 0);
  }

  // 30b) 纯 Surge 模式（不配 SANRI_PHONE / SANRI_ACCOUNTS）：**不能**判成「未配置」，
  //      要造 1 个占位账号把流程送进 ② Surge（历史上这里因账号为空而成了死代码）
  {
    const cfgPure = makeTestCfg({ surgeUrl: 'http://127.0.0.1:9', surgeKey: 'k' });
    const pure = buildAccountList(cfgPure);
    check('pure-surge-source-exists', hasAnyCredentialSource(cfgPure), true);
    check('pure-surge-placeholder', pure.placeholder, true);
    check('pure-surge-one-account', pure.accounts.length, 1);
    // 下面几项用 map 取，避免占位账号被删时整个自检抛异常（要看到 FAIL 行，不是 stack）
    check('pure-surge-fp', pure.accounts.map((a) => a.fp), ['surge']);
    check('pure-surge-no-fake-cred', pure.accounts.map((a) => [a.fixedToken, a.mint]), [['', null]]);
    check('pure-surge-masked', pure.accounts.map((a) => a.masked), ['Surge自动获取']);
    check('pure-surge-no-problems', pure.problems.length, 0);

    // ② 真的被调到：recent 里的新鲜 token 直接成为业务请求头
    const hit = [];
    let surgeCalls = 0;
    const d = authDeps((req) => {
      if (req.path === SURGE_RECENT_PATH) { surgeCalls += 1; return reply({ requests: [surgeRec(TOK2)] }); }
      return aliveStub(hit)(req);
    });
    const acc0 = pure.accounts[0] || { fp: 'missing', mint: null, masked: '', fixedToken: '', phone: '' };
    const repPure = await runAccount(acc0, 0,
      makeTestCfg({ surgeUrl: 'http://127.0.0.1:9', surgeKey: 'k' }), d);
    check('pure-surge-called', surgeCalls, 1);
    check('pure-surge-header', [...new Set(hit.filter((x) => x[1]).map((x) => x[1]))], [TOK2]);
    check('pure-surge-authsource', repPure.authSource, 'surge');
    check('pure-surge-not-failed', Boolean(repPure.failed || repPure.invalid), false);
  }

  // 30c) 纯 Surge + 抓包里一个可用 token 都没有 → NO_CREDENTIAL + 4 步指引（**不是**「未配置」）
  {
    const cfgPure2 = makeTestCfg({ surgeUrl: 'http://127.0.0.1:9', surgeKey: 'k' });
    const acc2 = buildAccountList(cfgPure2).accounts[0]
      || { fp: 'missing', mint: null, masked: '', fixedToken: '', phone: '' };
    const d = authDeps((req) => {
      if (req.path === SURGE_RECENT_PATH) return reply({ requests: [] });
      if (req.path === SURGE_SESSIONS_PATH) return reply({ sessions: [] });
      throw new Error(`未拿到凭证时不该发业务请求: ${req.path}`);
    });
    const rep2 = await runAccount(acc2, 0, cfgPure2, d);
    check('pure-surge-empty-kind', rep2.kind, KIND.NO_CREDENTIAL);
    check('pure-surge-empty-no-cred', rep2.noCredential, true);
    const all2 = [buildNotice([rep2], cfgPure2)].map((n) => `${n.title}\n${n.content}`).join('');
    checkTrue('pure-surge-empty-step3', all2.includes('SANRI_SURGE_URL + SANRI_SURGE_KEY'));
    checkTrue('pure-surge-empty-step1', all2.includes('幸运三日签活动页'));
    // 关键：「未拿到凭证」不能退化成「未配置」（两者给用户的可行动作不同）
    check('pure-surge-empty-not-missing', all2.includes('未配置任何凭证来源'), false);
    check('pure-surge-empty-no-alert', matchesAlertRouting(all2), false);
  }

  // 30d) 三者全空 → 仍然报 MSG_MISSING（由 hasAnyCredentialSource 决定，不变）
  {
    const cfgNone = makeTestCfg();
    check('none-configured-source', hasAnyCredentialSource(cfgNone), false);
    const none = buildAccountList(cfgNone);
    check('none-configured-accounts', [none.accounts.length, none.placeholder], [0, false]);
  }

  // 30e) SANRI_PHONE + Surge 都配 → 用 SANRI_PHONE 的 token，**不问** Surge（请求次数 0）
  {
    const cfgBoth = makeTestCfg({ phoneRaw: TOK1, surgeUrl: 'http://127.0.0.1:9', surgeKey: 'k' });
    const both = buildAccountList(cfgBoth);
    check('both-one-account', both.accounts.length, 1);
    check('both-no-placeholder', both.placeholder, false);
    check('both-fixed-token', both.accounts.map((a) => maskSecret(a.fixedToken)), [maskSecret(TOK1)]);
    const hit = [];
    let surgeCalls = 0;
    const d = authDeps((req) => {
      if (String(req.path || '').startsWith('/v1/')) {
        surgeCalls += 1;
        throw new Error('配了 SANRI_PHONE 就不该问 Surge');
      }
      return aliveStub(hit)(req);
    });
    const repBoth = await runAccount(both.accounts[0]
      || { fp: 'missing', mint: null, masked: '', fixedToken: '', phone: '' }, 0, cfgBoth, d);
    check('both-surge-not-called', surgeCalls, 0);
    check('both-token-used', [...new Set(hit.map((x) => x[1]))], [TOK1]);
    check('both-authsource', repBoth.authSource, 'phone');
  }

  // 31) mint 的两个「通道性」拒绝码归到新分类，且文案**不命中**失效分流关键词
  {
    const cases = [
      ['213245', KIND.MINT_CLOSED, '一键登录旧通道已被服务端关闭'],
      ['110001', KIND.MINT_NETWORK, '运营商侧拒绝'],
    ];
    for (const [code, kind, wording] of cases) {
      const d = authDeps(() => { throw new Error('通道不可用后不该发业务请求'); },
        { mint: () => mintReply(code, '请重新登录') });
      const cfgM = makeTestCfg();
      const repM = await runAccount(fakeAccount(44), 0, cfgM, d);
      check(`mint-${code}-kind`, repM.kind, kind);
      check(`mint-${code}-no-cred`, repM.noCredential, true);
      check(`mint-${code}-no-login`, d.seen, ['mint']);
      check(`mint-${code}-not-invalid`, repM.invalid, false);
      check(`mint-${code}-no-state`, Object.keys(cfgM.state.accounts).length, 0);
      const notice = buildNotice([repM], cfgM);
      const all = `${notice.title}\n${notice.content}`;
      check(`mint-${code}-wording`, all.includes(wording), true);
      // 关键：不得灌进失效提醒 Bot（服务端 retDesc 自带的「请重新登录」也绝不能漏进来）
      check(`mint-${code}-no-alert`, matchesAlertRouting(all), false);
      check(`mint-${code}-rerun`, all.includes(RERUN_CMD), true);
    }
    // 其它 retCode 保持既有分类（非静默 → 凭证通道）
    const dOther = authDeps(() => { throw new Error('x'); }, { mint: () => mintReply('999999', '其他') });
    const repOther = await runAccount(fakeAccount(45), 0, makeTestCfg(), dOther);
    check('mint-other-credential', repOther.invalid, true);
  }

  // 32) 三条来源全无 → 零业务请求 + 通知里给出 4 步可执行指引
  {
    const d = authDeps(() => { throw new Error('未拿到凭证时不该发业务请求'); });
    const cfgNone = makeTestCfg();
    const noCredAccount = { ...tokenAccount(3, TOK1), fixedToken: '' }; // 既没 token 也没 mint
    const repNone = await runAccount(noCredAccount, 0, cfgNone, d);
    check('nocrd-zero-req', d.seen, []);
    check('nocrd-kind', repNone.kind, KIND.NO_CREDENTIAL);
    check('nocrd-no-cred', repNone.noCredential, true);
    check('nocrd-not-invalid', repNone.invalid, false);
    const notice = buildNotice([repNone], cfgNone);
    const all = `${notice.title}\n${notice.content}`;
    checkTrue('nocrd-title', notice.title.includes('未拿到可用凭证'));
    checkTrue('nocrd-step1', all.includes('幸运三日签活动页'));
    checkTrue('nocrd-step2', all.includes('复制请求头 phone 的值'));
    checkTrue('nocrd-step3', all.includes('SANRI_SURGE_URL + SANRI_SURGE_KEY'));
    checkTrue('nocrd-step4', all.includes('30 分钟'));
    checkTrue('nocrd-rerun', all.includes(RERUN_CMD));
    // 「未拿到凭证」不是「凭证失效」：两个方向都得对
    check('nocrd-no-alert', matchesAlertRouting(all), false);
    check('nocrd-msg-no-alert', matchesAlertRouting(`${TASK_TITLE} ❌ 未配置\n${MSG_MISSING}`), false);
  }

  // 33) 通知节流：同一份失效凭证/未拿到凭证，每账号每天只推一次（cron 是每 10 分钟）
  {
    const cfgT = makeTestCfg();
    const accT = tokenAccount(4, TOK1);
    const mk = () => ({ tag: 'x', kind: 'error', invalid: true, lines: [], failed: false });
    const r1 = throttleNotice(mk(), accT, cfgT, '2026-11-26');
    const r2 = throttleNotice(mk(), accT, cfgT, '2026-11-26');
    const r3 = throttleNotice(mk(), accT, cfgT, '2026-11-27');
    check('throttle-first', Boolean(r1.suppressNotify), false);
    check('throttle-second', r2.suppressNotify, true);
    check('throttle-next-day', Boolean(r3.suppressNotify), false);
    check('throttle-ok-account', Boolean(throttleNotice({ kind: 'done' }, accT, cfgT, '2026-11-28').suppressNotify), false);
    check('throttle-persisted', cfgT.state.mint[accT.fp].noticeDate, '2026-11-27');
    check('all-quiet-suppressed', allAccountsQuiet([{ kind: 'error', suppressNotify: true }]), true);
    check('all-quiet-partial-suppressed', allAccountsQuiet([{ kind: 'error', suppressNotify: true }, { kind: 'error' }]), false);
    // 未配置告警也是每天一次（否则 cron 每 10 分钟 = 144 条）
    const cfgC = makeTestCfg();
    check('config-notice-first', needsConfigMissingNotice(cfgC, '2026-11-26'), true);
    check('config-notice-second', needsConfigMissingNotice(cfgC, '2026-11-26'), false);
    check('config-notice-next-day', needsConfigMissingNotice(cfgC, '2026-11-27'), true);
    // 新增的 notice 字段要能落盘——否则节流器重启即失效（而 cron 每次都是新进程）
    const tmpState2 = path.join(os.tmpdir(), `sanri-selfcheck-notice-${process.pid}.json`);
    saveState(tmpState2, cfgC.state);
    check('notice-state-roundtrip', loadState(tmpState2).notice.configMissingDate, '2026-11-27');
    if (fs.existsSync(tmpState2)) fs.unlinkSync(tmpState2);
  }


  // 15) 离线守卫本身有效：默认 transport 必须抛「自检禁止联网」
  {
    let blocked = false;
    try {
      await apiPost({ phone: FAKE, masked: maskSecret(FAKE) }, cfg, 'task/getTaskSignInfo', {}, {});
    } catch (e) {
      blocked = e instanceof SanriError && /自检禁止联网/.test(e.message);
    }
    check('offline-default-transport-blocked', blocked, true);
    checkTrue('offline-stub-was-hit', netHits.length >= 1);
  }

  transport = realTransport;
  globalThis.fetch = realFetch;

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
    selfcheck().catch((e) => {
      console.error(`${LOG_PREFIX} selfcheck 自身异常: ${e && e.message ? e.message : e}`);
      process.exitCode = 1;
    });
  } else {
    main().catch(async (error) => {
      const msg = error instanceof SanriError
        ? error.message
        : `未知错误: ${error && error.message ? error.message : String(error)}`;
      const isConfig = error instanceof SanriError && error.type === 'config_missing';
      logErr(`❌ ${isConfig ? '配置缺失' : '发生异常:执行失败'}`);
      logErr(msg);
      const content = isConfig
        ? msg
        : `❌ 发生异常:执行失败\n\n${noticeSafe(msg)}\n\n👉 排障后请手动重跑: ${RERUN_CMD}`;
      try { await notify(`${TASK_TITLE} 执行失败`, content); } catch { /* 通知失败不覆盖原错误 */ }
      process.exitCode = 1;
    });
  }
}

module.exports = {
  SanriError,
  KIND,
  maskSecret,
  maskPhone,
  fingerprint,
  classifyLogin,
  loginBody,
  buildAppTicket,
  mintAppTicket,
  loginCredential,
  readMask,
  writeMask,
  mintState,
  MINT_URL,
  MINT_PATH,
  MINT_RISK_SILENCE_SEC,
  MINT_MIN_INTERVAL_SEC,
  isRiskPayload,
  markRiskCooldown,
  RISK_COOLDOWN_SEC,
  RISK_EXPLAIN,
  MINT_MAX_PER_DAY,
  LOGIN_URL,
  redact,
  noticeSafe,
  matchesAlertRouting,
  parseAccounts,
  parseTokens,
  buildAccountList,
  hasAnyCredentialSource,
  surgePlaceholderAccount,
  resolveCredential,
  surgeTokens,
  pickPhoneTokens,
  headerValue,
  isActivityUrl,
  surgeRecordAt,
  throttleNotice,
  credentialHowto,
  NO_CRED_HOWTO,
  MSG_NEED_PHONE,
  MINT_CLOSED_CODES,
  MINT_NETWORK_CODES,
  ORIGIN_HOST,
  DEFAULT_TOKEN_MAX_AGE_MIN,
  parseActivities,
  parseSignInfo,
  classify,
  describeGate,
  unwrapNested,
  nestedVerdict,
  findSignAward,
  pickPrizeName,
  emptyState,
  loadState,
  saveState,
  accountState,
  readAccountState,
  credentialHint,
  isDayComplete,
  resetForNewDay,
  bumpCredFails,
  allAccountsQuiet,
  buildConfigMissingNotice,
  needsConfigMissingNotice,
  numOrNull,
  SIGN_VERIFY_ATTEMPTS,
  SIGN_VERIFY_GAP_MS,
  todayShanghai,
  runAccount,
  buildNotice,
  readConfig,
  MSG_MISSING,
  RERUN_CMD,
  DEFAULT_ACTIVITIES,
};
