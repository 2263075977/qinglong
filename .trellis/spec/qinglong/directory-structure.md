# 目录结构

> 本仓库的物理组织方式,以及**为什么几乎不存在公共代码**。

---

## 目录布局

```
qinglong/
├── fuliba/
│   ├── autosing.py          # 福利吧签到(Python)
│   └── sendNotify.py        # 青龙通知模块,外部引入,勿改
└── gongyizhan/
    ├── anyrouter.js
    ├── aokicore-browser.js
    ├── bohe.js
    ├── elysia.js
    ├── hyb-cards-draw.js
    ├── hyb-daily-playwright.js
    ├── hyb-farm.js
    ├── laomo-browser.js
    ├── newapi.js            # 压缩产物,勿手改
    ├── runanytime-browser.js
    ├── sendNotify.js        # 青龙通知模块,外部引入,勿改
    ├── sharedchat-vibe-claim.js
    └── whos-daily.js
```

**目录 = 站点来源**,不是分层。`fuliba/` 与 `gongyizhan/`(公益站)两个来源各一个目录,新增站点时按来源建目录或放进已有目录。

---

## 单脚本自包含(核心原则)

这是本仓库最重要的结构约束:

> **除 `sendNotify` 外,脚本之间不共享任何代码。**

实测:`sleep` 在 3 个文件里各定义了 1 次;`normalizeCookie` / `normalize_cookie` 在 7 个文件里各实现了一遍;`cleanString` 2 次;`parseJsonSafe` 2 次。

**这是有意为之,不是技术债。** 原因:

- 每个脚本要能被**单独复制**进青龙面板的脚本目录运行,面板不会同步仓库里的公共模块
- 站点 Cookie 形态各异(有的支持 `Cookie:` 前缀、引号、多行),各自 `normalizeCookie` 的容错边界不同

**因此**:

- ✅ 新增脚本时,复制相近脚本的辅助函数并**按站点需要调整**
- ❌ 不要为了"消除重复"新建 `gongyizhan/utils/` 之类的共享模块
- ❌ 不要把 `sendNotify` 之外的逻辑抽到外部文件

唯一的例外是 `sendNotify` —— 青龙生态的标准通知模块,两个语言各一份,由脚本**动态查找并降级**加载(见 [logging-and-notify.md](./logging-and-notify.md))。

---

## 文件命名

| 类型 | 约定 | 实例 |
|------|------|------|
| 普通 HTTP 脚本 | `<站点小写>.js` | `anyrouter.js`、`bohe.js`、`elysia.js` |
| 需要浏览器的脚本 | `<站点>-browser.js` | `aokicore-browser.js`、`laomo-browser.js`、`runanytime-browser.js` |
| 站点内多任务 | `<站点>-<任务>.js` | `hyb-cards-draw.js`、`hyb-farm.js`、`hyb-daily-playwright.js` |
| 需绕过指纹检测 | 后缀体现手段 | `hyb-daily-playwright.js`(Playwright 版) |
| Python 脚本 | `<站点拼音>.py` | `autosing.py` |

`-browser` 后缀是一个**有意义的信号**:看到它就知道该脚本依赖 Playwright、会启动真实浏览器、本地几乎不可能跑通。

---

## 不可手改的文件

| 文件 | 原因 |
|------|------|
| `gongyizhan/newapi.js` | 压缩产物:71 行、434,361 字节,单行极长。**它是 `gongyizhan/` 里唯一的 0 缩进压缩文件**。改动应在上游源码完成后重新打包,不要在此文件里直接编辑。 |
| `fuliba/sendNotify.py`、`gongyizhan/sendNotify.js` | 外部引入的青龙通知模块(对外契约),不是自研代码。**不要按本仓库风格"统一"它们**,也不要为它们补中文日志规范。 |

---

## 各脚本规模(2026-10 实测)

供判断改动半径参考:

```
 71  gongyizhan/newapi.js              # 压缩,勿改
 73  gongyizhan/sendNotify.js          # 外部模块
211  gongyizhan/elysia.js
224  fuliba/autosing.py
434  gongyizhan/runanytime-browser.js
470  gongyizhan/anyrouter.js
494  gongyizhan/bohe.js
547  fuliba/sendNotify.py              # 外部模块
662  gongyizhan/hyb-daily-playwright.js
663  gongyizhan/hyb-cards-draw.js
800  gongyizhan/laomo-browser.js
821  gongyizhan/aokicore-browser.js
1219 gongyizhan/sharedchat-vibe-claim.js
1500 gongyizhan/whos-daily.js
2015 gongyizhan/hyb-farm.js            # 最复杂的脚本(农场状态机)
```

`hyb-farm.js` 是复杂度上限参照:它有独立的限流预算、通知冷却、成熟时间推算逻辑。改动它前先读 [error-handling.md](./error-handling.md)。