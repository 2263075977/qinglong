# 质量约定

> **本文件最重要的一节是"本地能验证什么"** —— 因为 Trellis 子代理默认的收尾动作是 `run project lint and type-check`,而这个仓库两者都不存在。

---

## ⚠️ 先读:本仓库没有 lint / 测试 / CI

```bash
$ ls package.json requirements.txt tsconfig.json .github
ls: cannot access ...: No such file or directory
```

**事实清单:**

| 期望的设施 | 实际状态 |
|---|---|
| `package.json` / `package-lock.json` | ❌ 不存在 |
| `requirements.txt` / `pyproject.toml` | ❌ 不存在 |
| Lint(eslint / ruff / flake8) | ❌ 未配置 |
| 单元测试 / 测试框架 | ❌ 零测试文件 |
| CI(GitHub Actions 等) | ❌ 不存在 |
| TypeScript / 类型检查 | ❌ 全部是 JS 与 Python |

**因此:**

- ❌ 不要为了"让 lint 有地方挂"而新建 `package.json`
- ❌ 不要声称"已通过测试 / lint / 类型检查"
- ❌ `trellis-implement` / `trellis-check` 的"run project lint and type-check"指令在此仓库**无对应物**,请改用下一节的替代验证

---

## 一、本地唯一能自动化的验证:语法检查

这是本仓库**唯一**可自动执行的正确性检查。改动任何脚本后必须跑:

```bash
# JavaScript —— 逐文件
node --check gongyizhan/bohe.js

# Python —— 逐文件
python -m py_compile fuliba/autosing.py
```

批量:

```bash
# 全部 JS
for f in gongyizhan/*.js; do node --check "$f" || echo "FAIL: $f"; done

# 全部 Python
python -m py_compile fuliba/*.py gongyizhan/*.py && echo "py OK"
```

`node --check` 能捕获:语法错误、括号不匹配、误用保留字。**它捕获不到**逻辑错误、拼写错误的变量名(运行时才炸)、错误的环境变量名。

> 跑完 `py_compile` 会生成 `__pycache__/`。仓库根目录**原先没有** `.gitignore`,已补上一份(含 `__pycache__/`、`*.pyc`、`node_modules/`),不要提交缓存目录。

---

## 二、本地**不能**验证的部分

| 项目 | 原因 |
|------|------|
| 完整签到流程 | 需要真实 Cookie + 目标站点在线 |
| 浏览器脚本(`*-browser.js`、`hyb-daily-playwright.js`、`sharedchat-vibe-claim.js`) | 需要 Playwright + Chromium + 图形环境;云服务器上依赖 Xvfb(见提交 `fix(gongyizhan): 默认有头并自动使用 Xvfb`) |
| 通知发送 | 需要青龙面板 + 已配置的推送渠道 |
| 多账号逻辑 | 需要多个真实账号的环境变量 |
| 限流退避 | 需要真的被 Cloudflare 限流 |

**结论:能自动化验证的只有语法,其余靠代码审阅。** 不要因为无法端到端验证就跳过语法检查,也不要假装端到端验证过。

---

## 三、代码审阅清单

改动脚本时人工核对(也是 `trellis-check` 应重点看的):

### 结构

- [ ] 脚本头部有 `cron:` 和 `new Env('中文名')`,位置在 shebang 之后
- [ ] 除 `sendNotify` 外**没有**引入仓库内其他文件(`require('./xxx')` 除了 `./sendNotify`)
- [ ] 需要被 require 的脚本有 `if (require.main === module)` 守卫
- [ ] 有 `module.exports` 时,导出的是**可测试的纯函数**,不是副作用

### 配置

- [ ] 新增环境变量跟随站点前缀(`HYB_FARM_*`、`WHOS_*` ...),没有裸名变量
- [ ] 必需变量缺失时给出**中文配置步骤**,不是 `missing env`
- [ ] 超时类变量带 `_MS` 后缀
- [ ] 若支持 `.env`,遵守"已存在的环境变量优先"

### 日志与通知

- [ ] 每行日志带方括号前缀
- [ ] **没有明文打印 Cookie / token / JWT**(`runanytime-browser.js:275` 是唯一有意例外)
- [ ] 打印服务端对象前过了 `scrubResponse()`
- [ ] 异常路径**也发通知**
- [ ] 高频脚本(`*/30 * * * *`)有通知冷却

### 错误处理

- [ ] 有站点专属错误类(`<Site>Error extends Error`)
- [ ] 顶层 `catch` 把技术错误翻译成中文可行动文案
- [ ] 设置了 `process.exitCode = 1`(用 `exitCode` 不用 `exit()`)
- [ ] 多账号 / 多轮循环内**单个失败不中断整轮**
- [ ] 重试有等待预算上限,且只对安全重试的错误(429)重试

### 逆向工程类改动(浏览器脚本常见)

- [ ] 接口路径、PoW/JWT 逻辑变更时同步更新**头部注释里的说明**(参照 `runanytime-browser.js` 头部的 5 步认证流程说明)
- [ ] 魔改的编码解码逻辑(如 `decodeGobSignedInt`)保留说明其来源与格式

---

## 四、依赖约定

仓库**不声明依赖**,因为依赖由青龙面板/容器提供:

| 依赖 | 使用脚本 | 备注 |
|------|----------|------|
| `playwright` | `aokicore-browser.js`、`elysia.js`、`sharedchat-vibe-claim.js` | 需容器内已装 Chromium 与系统库 |
| `rebrowser-playwright` | `laomo-browser.js` | Playwright 的反检测分支,用于绕过指纹识别 |
| `requests` | Python 脚本 | 标准库外唯一依赖 |
| `ddddocr` | 早期验证码场景 | 见 `gongyizhan/jianzhile.py` 头部声明 |
| Node 内置模块 | 大部分脚本 | `node:fs` / `node:http` / `node:https` / `node:crypto` / `node:vm` |

**优先使用 Node 内置模块。** 多数脚本 `gongyizhan/anyrouter.js`、`bohe.js`、`hyb-cards-draw.js`、`hyb-farm.js` 用原生 `http`/`https` 手写请求,而不是引入 axios/fetch 库 —— 因为青龙容器不保证有这些包。**新增脚本沿用原生模块**,除非必须用 Playwright。

`node:vm` 仅在 `anyrouter.js` 中用于执行站点的挑战脚本,不要扩散使用。

---

## 五、提交信息约定

实测遵循 **Conventional Commits + 中文描述 + 站点 scope**:

```
feat(gongyizhan): whos.tv 每日任务自动化
fix(gongyizhan): hyb-farm 429 限流单独分类并按预算退避重试
chore(gongyizhan): 移除 100xLabs 签到脚本
refactor(gongyizhan): runanytime 适配 JWT 认证并改为纯 HTTP 签到
fix(newapi): 修复失败通知分流
```

| 部分 | 约定 |
|------|------|
| 类型 | `feat` / `fix` / `refactor` / `chore` |
| scope | 目录名或站点名:`(gongyizhan)`、`(newapi)`、`(fuliba)` |
| 描述 | **中文**,说明**做了什么 + 为什么**。修复类要写清根因,如 `429 限流单独分类并按预算退避重试` |

一个提交只做一件事(历史里 `feat`/`fix`/`refactor` 界限清晰)。**不要**把多个站点的改动塞进一个提交。

---

## 六、测试导出模式(若要补可测函数)

多个脚本已把纯函数导出,便于将来加测试(`aokicore-browser.js:791`):

```js
module.exports = {
  AokiCoreBrowserError,
  buildUserIdCandidates,
  cleanString,
  decodeBase64BufferLoose,
  decodeGobSignedInt,
  extractGobFieldInts,
  extractUserIdsFromCookie,
  // ...
};
```

**这是本仓库的既有风格**:把可纯函数化的逻辑(`normalizeCookie`、`decodeGobSignedInt`、`buildUserIdCandidates`)导出。

**但不要只为了测试而引出重构。** 当前零测试是既有现状;若某次改动需要验证纯函数逻辑,可以先导出、本地用 `node -e` 手动验证,不必立刻搭测试框架:

```bash
node -e "const m = require('./gongyizhan/bohe.js'); console.log(m.normalizeCookie('Cookie: a=1'));"
```

注意:这样做会执行模块顶层代码(若模块有副作用则可能触发网络请求),优先选无副作用的导出。

---

## 七、注入依赖以支持本地验证

较新的脚本用**依赖注入**把不可测的部分参数化(`hyb-farm.js:623`):

```js
async function requestJson(config, apiPath, options = {}, dependencies = {}) {
  const request = dependencies.request || requestJsonOnce;
  const wait = dependencies.wait || sleep;
  const log = dependencies.log || console.log;
  // ...
}
```

**新写可测逻辑时沿用此模式**:`dependencies.xxx || 默认实现` 的写法让调用方(和将来可能的测试)注入桩函数,而不必联网。实测 `hyb-farm.js` 有 14 处、`sharedchat-vibe-claim.js` 有 13 处。

---

## 相关文档

- 单脚本自包含原则 → [directory-structure.md](./directory-structure.md)
- 脱敏函数实现 → [logging-and-notify.md](./logging-and-notify.md)
- 退避与预算 → [error-handling.md](./error-handling.md)