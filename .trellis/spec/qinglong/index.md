# 青龙脚本规范(Qinglong Scripts)

> 本仓库是**青龙面板签到脚本集合**,不是常规 Web 项目。

---

## 这个仓库是什么

`E:/qinglong` 下只有两类东西:

| 目录 | 内容 |
|------|------|
| `fuliba/` | Python 脚本(福利吧签到)+ 自带的 `sendNotify.py` |
| `gongyizhan/` | Node.js 脚本(12 个站点任务)+ 自带的 `sendNotify.js` |

**没有** `package.json`、`requirements.txt`、构建配置、测试框架、CI,也**没有前端代码**。

> 因此 `trellis init` 当初探测到的 "fullstack + backend/frontend 双层模板" 是误判 —— 仓库里没有任何依赖清单文件,探测器 `detectProjectType` 返回 `unknown` 后回落到了 fullstack 默认值。原 `frontend/` 层(React/TS 模板)已删除。

---

## 运行环境

脚本的**真实运行环境是青龙面板容器**,不是本机:

- 平台注入 `cron` 调度脚本(每个脚本头部的 `cron:` 注释就是面板里的调度表达式)
- 平台通过**环境变量**传账号(见 [env-and-config.md](./env-and-config.md))
- 平台提供 `sendNotify` 通知模块(脚本自行在多路径中查找,见 [logging-and-notify.md](./logging-and-notify.md))

本机(Linux/WSL/Windows)**没有** `QL_DIR`、没有 Cookie,所以**绝大多数脚本无法在本地跑通完整流程**。本地只能做语法与静态检查 —— 见 [quality-guidelines.md](./quality-guidelines.md)。

---

## 规范索引

| 文档 | 内容 |
|------|------|
| [directory-structure.md](./directory-structure.md) | 脚本放哪、单脚本自包含原则、不可手改的文件 |
| [env-and-config.md](./env-and-config.md) | 环境变量命名前缀、必需/可选约定、多账号写法 |
| [logging-and-notify.md](./logging-and-notify.md) | 脚本头注释格式、日志前缀与 emoji、sendNotify 加载与降级 |
| [error-handling.md](./error-handling.md) | 自定义错误类、顶层兜底、429 限流退避 |
| [quality-guidelines.md](./quality-guidelines.md) | 本地能做什么检查(唯一能自动化的部分)、代码审阅要点 |

---

## 三条最容易被违反的约定

1. **单脚本自包含** —— 除 `sendNotify` 外,不要在脚本间抽公共 utils。每个脚本必须能单独复制进青龙面板运行。
2. **`gongyizhan/newapi.js` 不要手改** —— 它是压缩产物(71 行 / 434KB)。
3. **文档与注释用中文** —— 与仓库现状一致(日志、通知文案、错误提示全为中文)。

---

**语言**:本 spec 目录使用**中文**。Trellis 模板默认要求英文,此处有意覆盖:仓库内所有注释、日志、通知文案均为中文,写英文 spec 会导致子代理产出中英混杂的代码。