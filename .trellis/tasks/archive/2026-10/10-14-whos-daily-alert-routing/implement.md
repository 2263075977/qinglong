# 执行计划(交接给新对话)

> 本文件是「新对话执行」的交接说明。执行前先读 `prd.md`。
> **注意**:任务当前仍是 `planning`;执行前需先 `task.py start`,并确认 `prd.md` 的 **Q1** 已由用户回答。

## 背景(30 秒速览)

`gongyizhan/whos-daily.js` 的失败通知**已经发出**,但文案不含青龙 Node-RED 分流用的关键词,所以全部落到**普通 TG Bot**,永远进不了**失效提醒 Bot**。

判定关键词表(Node-RED function node `配置区:双TG Bot分流`):
```
已失效,无效用户,失效,cookie失效,ck失效,登录失效,账号失效,账号过期,重新登录,发生异常,invalid,expired
```
匹配规则:标题 + 正文拼接 → 转小写 → **原文匹配一次 + 去掉所有空白后再匹配一次**。命中任一 → 走 alertBot(且因 `sendNormalWhenAlert: false`,**不再**发普通 Bot)。

## 改动点(仅 `gongyizhan/whos-daily.js` 一个文件 + spec 一处)

### 1. 会话验证失败(必改,修复你这次遇到的问题)

`whos-daily.js:1294-1297`

```js
  const fatal = summary.errors.find(e => e.type === 'auth_failed');
  if (fatal && !summary.signin) {
    lines.push('❌ 登录失败,请更新 WHOS_COOKIE');   // ← 改这一行
    return lines.join('\n');
  }
```

改为(命中 `已失效` + `cookie已失效`(紧凑匹配)+ `重新登录`,同时保留操作指引):

```js
    lines.push('❌ Cookie 已失效,请重新登录获取后更新 WHOS_COOKIE');
```

### 2. 中途 auth_failed 熔断

`whos-daily.js:1371-1373`

```js
    if (summary.errors.some(e => e.type === 'auth_failed')) {
      lines.push('请更新环境变量 WHOS_COOKIE');      // ← 改这一行
    }
```

改为:

```js
      lines.push('❌ Cookie 已失效,请重新登录获取后更新环境变量 WHOS_COOKIE');
```

### 3. 顶层异常兜底

`whos-daily.js:1457`

```js
      const failureText = `❌ 执行失败\n\n错误类型: ...`;   // ← 改这一行
```

改为(对齐 `anyrouter.js:419` / `bohe.js:472` / `hyb-cards-draw.js:638` 的 `❌ 发生异常:` 习惯写法):

```js
      const failureText = `❌ 发生异常:执行失败\n\n错误类型: ${error.type || 'runtime_error'}\n错误信息: ${scrubText(error.message)}`;
```

### 4. 标题带失效标记(推荐,与 `hyb-farm.js:1778` 同思路)

`whos-daily.js:1449`

```js
    await sendNotification(TASK_TITLE, resultText);
```

改为:

```js
    const fatalAuth = summary.errors.some(e => e.type === 'auth_failed');
    await sendNotification(fatalAuth ? `${TASK_TITLE} · Cookie 已失效` : TASK_TITLE, resultText);
```

理由:Node-RED 把标题和正文拼起来判定,标题带标记可让「正文被 Telegram 截断 / 未来改文案」时仍能分流。

### 5. spec 同步(Phase 3.3)

在 `.trellis/spec/qinglong/error-handling.md`(失败分类表附近)与 `logging-and-notify.md`(「发送时机」表附近)各加一条约定,内容要点:

- 失败通知文案必须对齐下游分流关键词表,凭证/登录类失败至少覆盖 `已失效` 与 `重新登录`;
- 顶层异常兜底统一以 `❌ 发生异常:` 开头;
- 给出等价的匹配函数(小写 + 去空白双匹配)供后续人工核对。

## 待 Q1 决定的部分

**已裁定:D1 = 方案 A** —— 只覆盖「凭证/登录类失败 + 顶层异常兜底」,不做下列追加。网络超时、`schema_changed`、任务级 `❌ 签到失败` 等文案**保持原样**。Node-RED 关键词表**不改**。

## 验证结果(Phase 2 已完成)

实现与检查已执行,实际 diff:

```
 .trellis/spec/qinglong/error-handling.md     |  2 ++
 .trellis/spec/qinglong/index.md              |  5 +++--
 .trellis/spec/qinglong/logging-and-notify.md | 31 +++++++++++++++++++++++
 gongyizhan/whos-daily.js                     |  9 ++++----
```

- `node --check gongyizhan/whos-daily.js` → OK
- AC1/AC2/AC3 命中关键词;AC10a/b/c(负向)命中 0 —— 全部通过。
- 关键发现:whos-daily 的 `run()` **内部从不 throw**(所有失败均被 `recordError` 吞下并 `return summary`),故顶层 catch 仅用于**设计外故障**(如 `sendNotification` 本身异常);它加 `发生异常` **不会**把常规网络超时误送入失效 Bot,不违背 D1。

## 验证命令(仓库无 lint / 无测试,只有这些)

```bash
# 1. 语法检查(唯一可自动化项)
node --check gongyizhan/whos-daily.js

# 2. 桩数据 + Node-RED 等价匹配函数,三场景断言命中 > 0
node -e "
const m = require('./gongyizhan/whos-daily.js');
const KW='已失效,无效用户,失效,cookie失效,ck失效,登录失效,账号失效,账号过期,重新登录,发生异常,invalid,expired';
const hit=t=>{t=t.toLowerCase();const c=t.replace(/\s+/g,'');return KW.split(',').filter(k=>k&&(t.includes(k)||c.includes(k.replace(/\s+/g,''))));};
const A=m.formatResult({user:'',signin:null,errors:[{stage:'profile',type:'auth_failed',message:'登录失败'}]});
const B=m.formatResult({user:'u',signin:{type:'success',pointsEarned:5,streakBonus:0,consecutiveDays:3,balance:100},
  errors:[{stage:'rate_favorite',type:'auth_failed',message:'熔断'}]});
const C='❌ 发生异常:执行失败\n\n错误类型: network_error\n错误信息: timeout';
for (const [n,t] of [['A',A],['B',B],['C',C]]) console.log(n, JSON.stringify(hit(t)));
console.log('A 含 WHOS_COOKIE:', A.includes('WHOS_COOKIE'));
console.log('B 含 WHOS_COOKIE:', B.includes('WHOS_COOKIE'));
"

# 3. diff 范围核对
git diff --stat
```

## 回滚点

单文件、纯字符串改动 → `git checkout -- gongyizhan/whos-daily.js` 即可完全回滚。

## 风险 / 注意

- **不要顺手改 Node-RED 的关键词表**:本仓库不承载该 flow,改了不在版本控制内、无痕迹。
- **不要扩大成功路径文案**:`✅ 签到成功` / `⏭️ 今日已签到` 等保持原样(`⏭️`/`✅` 不含关键词,本来就不会误入 alertBot)。
- 用户仍需在青龙面板更新 `WHOS_COOKIE` —— 文案修复**不能**让过期 Cookie 复活。
- 割裂点提醒:若线上 Node-RED 节点的 CONFIG 仍是 `示例` / `REPLACE_WITH_` 形态,会直接回 500,那是另一个独立故障;执行前可让用户确认。