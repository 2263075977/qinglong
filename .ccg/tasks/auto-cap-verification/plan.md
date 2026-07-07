# 实施计划：HYB Dashboard 自动 CAP 处理方案

## 需求摘要

为 `hyb-dashboard.js` 实现自动 CAP/Cloudflare 验证能力，消除人工干预。

**当前行为**：检测到 `capRequired=true` 时跳过操作并发送通知。

---

## ⚠️ 技术可行性评估结论

经 Antigravity 技术分析，**直接实现自动验证突破不可行且风险极高**：

- **账号封禁风险（High）**：重复提交无效 token 触发反欺诈 → 永久封号
- **IP 黑名单风险（High）**：VPS 频繁请求验证接口 → 403/429 封禁
- **凭证泄露风险（High）**：Cookie 传输至第三方 solver → 账号劫持
- **维护成本（Medium）**：验证流程频繁变化 → 持续失效

**技术障碍**：
- 第三方 solver（2Captcha/CapSolver）需付费，成功率 60-85%，延迟 15-60s
- Headless 浏览器（Puppeteer/Playwright）无法在青龙 Docker 轻量环境运行

---

## 推荐方案对比

| 方案 | 自动化程度 | 风险等级 | 实施复杂度 | 维护成本 |
|------|-----------|---------|-----------|---------|
| **方案 A: Tampermonkey Cookie 同步** | 半自动（需浏览器打开） | ✅ Low | 🟢 Low | 🟢 Low |
| **方案 B: 本地 Playwright 持久化** | 全自动（首次配置后） | ✅ Low | 🟡 Medium | 🟡 Medium |
| ~~方案 X: 第三方 Solver~~ | 全自动 | ❌ High | 🟡 Medium | 🔴 High |

---

## 方案 A: Tampermonkey Cookie 自动同步（推荐）

### 设计原理

1. 用户浏览器安装 Tampermonkey 用户脚本
2. 访问 `https://cdk.hybgzs.com/dashboard` 时自动触发脚本
3. 脚本提取当前 Cookie（已通过人工验证）
4. 通过青龙 OpenAPI 自动更新环境变量 `HYB_DASHBOARD_COOKIE`
5. 定时任务使用最新 Cookie，无需修改现有脚本

### 实施步骤

#### 1. 创建 Tampermonkey 脚本
**文件**: `userscripts/hyb-cookie-sync.user.js`

```javascript
// ==UserScript==
// @name         HYB Dashboard Cookie Auto-Sync
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  自动提取 HYB Dashboard Cookie 并同步至青龙面板
// @author       Your Name
// @match        https://cdk.hybgzs.com/*
// @grant        GM_xmlhttpRequest
// @connect      your-qinglong-host
// ==/UserScript==

(function() {
    'use strict';
    
    const QINGLONG_HOST = 'http://your-qinglong-host:5700';
    const QINGLONG_CLIENT_ID = 'your-client-id';
    const QINGLONG_CLIENT_SECRET = 'your-client-secret';
    const ENV_NAME = 'HYB_DASHBOARD_COOKIE';
    const CHECK_INTERVAL = 60000; // 1 分钟检查一次
    
    let lastCookie = '';
    
    function getCurrentCookie() {
        return document.cookie;
    }
    
    function updateQinglongEnv(cookie) {
        // 实现青龙 OpenAPI 调用逻辑
        // 详见：https://github.com/whyour/qinglong/blob/master/openapi/openapi.md
        console.log('[HYB Cookie Sync] Updating Qinglong env...');
        // TODO: 实现 API 调用
    }
    
    function checkAndSync() {
        const currentCookie = getCurrentCookie();
        if (currentCookie && currentCookie !== lastCookie) {
            lastCookie = currentCookie;
            updateQinglongEnv(currentCookie);
        }
    }
    
    // 页面加载时立即检查
    checkAndSync();
    
    // 定期检查 Cookie 变化
    setInterval(checkAndSync, CHECK_INTERVAL);
})();
```

#### 2. 配置青龙 OpenAPI 权限
```bash
# 在青龙面板 -> 系统设置 -> 应用设置 中创建应用
# 记录 Client ID 和 Client Secret
# 更新 Tampermonkey 脚本中的配置
```

#### 3. 测试验证
- 浏览器访问 `https://cdk.hybgzs.com/dashboard`
- 打开开发者工具查看 Console，确认脚本执行
- 在青龙面板查看环境变量 `HYB_DASHBOARD_COOKIE` 是否更新

#### 4. 现有脚本无需修改
`hyb-dashboard.js` 保持不变，继续使用环境变量中的 Cookie。

### 影响范围

- **新增**：`userscripts/hyb-cookie-sync.user.js`
- **修改**：无
- **测试**：手动测试 Tampermonkey 脚本同步功能

---

## 方案 B: 本地 Playwright 持久化会话

### 设计原理

1. 在本地机器（非 Docker）运行 Playwright 脚本
2. 首次启动时以 headed 模式打开浏览器，用户手动完成验证
3. 保存持久化浏览器 profile（包含 Cookie 和认证状态）
4. 后续自动任务复用 profile，跳过验证流程

### 实施步骤

#### 1. 创建 Playwright 脚本
**文件**: `gongyizhan/hyb-dashboard-playwright.js`

```javascript
const { chromium } = require('playwright');
const path = require('path');

const PROFILE_DIR = path.join(__dirname, '.browser-profile');
const DASHBOARD_URL = 'https://cdk.hybgzs.com/dashboard';

async function runWithPersistentContext() {
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, // 首次运行时设为 false，手动完成验证
    viewport: { width: 1280, height: 720 },
  });

  const page = await browser.newPage();
  await page.goto(DASHBOARD_URL);

  // TODO: 实现签到和转盘逻辑
  // 参考 hyb-dashboard.js 的 performCheckin 和 performWheel

  await browser.close();
}

runWithPersistentContext().catch(console.error);
```

#### 2. 安装依赖
```bash
npm install playwright
npx playwright install chromium
```

#### 3. 首次运行（人工完成验证）
```bash
node gongyizhan/hyb-dashboard-playwright.js
# 手动在打开的浏览器中完成 CAP 验证
```

#### 4. 后续自动运行
```bash
# 修改脚本 headless: true
# 配置本地 cron 或任务计划程序
```

### 影响范围

- **新增**：`gongyizhan/hyb-dashboard-playwright.js`
- **新增**：`package.json` 添加 `playwright` 依赖
- **修改**：无（原脚本保留作为备份）
- **测试**：本地环境测试持久化会话

---

## ❌ 不推荐：方案 X（第三方 Solver 集成）

### 为什么不推荐

1. **凭证泄露风险**：Cookie 需发送至 2Captcha/CapSolver 服务器
2. **账号封禁风险**：solver 生成的 token 成功率仅 60-85%，多次失败触发封号
3. **IP 封禁风险**：VPS IP 频繁请求验证接口被 Cloudflare 永久拉黑
4. **持续付费**：每次验证消耗 $0.002-0.005
5. **维护成本高**：站点验证流程变化时需更新集成代码

### 如果仍要实施（高风险）

参考 CapSolver 文档：https://docs.capsolver.com/guide/captcha/Cloudflare.html

**需修改**：
- `gongyizhan/hyb-dashboard.js` Line 636-640, 668-672
- 集成 CapSolver API 调用逻辑
- 增加重试和降级机制

---

## 最终推荐

**优先采用方案 A（Tampermonkey Cookie 同步）**：
- ✅ 零账号风险
- ✅ 零额外成本
- ✅ 实施简单
- ✅ 维护成本低

**适用人群**：每天至少会打开一次浏览器访问 Dashboard 的用户。

**劣势**：需要用户浏览器保持 Tampermonkey 脚本启用。

---

## 验收标准

### 方案 A
- [ ] Tampermonkey 脚本能正确提取 Cookie
- [ ] Cookie 自动同步至青龙面板环境变量
- [ ] `hyb-dashboard.js` 定时任务使用最新 Cookie 成功执行签到和转盘

### 方案 B
- [ ] Playwright 脚本能在本地环境运行
- [ ] 持久化 profile 保存认证状态
- [ ] 后续运行无需人工干预
- [ ] 签到和转盘功能正常
