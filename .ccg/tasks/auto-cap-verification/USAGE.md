# HYB Dashboard Playwright 自动化使用指南

## 📋 方案说明

本方案使用 Playwright 持久化会话技术，**首次手动完成 CAP 验证后**，后续运行将自动复用认证状态，无需重复验证。

---

## 🚀 快速开始

### 1. 安装依赖

在项目根目录执行：

```bash
npm install
npm run playwright:install
```

### 2. 首次运行（手动验证）

```bash
cd gongyizhan
node hyb-dashboard-playwright.js
```

**操作步骤**：
1. 脚本会自动打开浏览器并访问 Dashboard
2. 如果出现 CAP/Cloudflare 验证，**手动完成验证**
3. 等待页面完全加载
4. 关闭浏览器或在终端按 `Ctrl+C`

✅ **会话已保存到 `gongyizhan/.browser-profile/` 目录**

### 3. 后续自动运行

设置环境变量启用无头模式：

```bash
cd gongyizhan
PLAYWRIGHT_HEADLESS=true node hyb-dashboard-playwright.js
```

或

```bash
cd gongyizhan
PLAYWRIGHT_HEADLESS=1 node hyb-dashboard-playwright.js
```

---

## ⚙️ 环境变量配置

| 变量名 | 默认值 | 支持值 | 说明 |
|--------|--------|--------|------|
| `PLAYWRIGHT_HEADLESS` | `false` | `true`, `1`, `yes` (不区分大小写) | 是否无头模式（首次必须不设置或设为 `false`） |

---

## 🐳 Docker / 群晖 NAS 部署

### 群晖 Docker 环境

确认 Playwright 已安装：

```bash
docker exec -it <容器名> npx playwright --version
```

如果未安装，在容器内执行：

```bash
npm install playwright
npx playwright install chromium --with-deps
```

### 青龙面板集成

1. **上传脚本**：将 `hyb-dashboard-playwright.js` 上传到青龙的 `scripts` 目录

2. **首次运行**：在青龙容器内手动执行
   ```bash
   cd /ql/scripts
   node hyb-dashboard-playwright.js
   ```
   
   ⚠️ **注意**：青龙 Docker 通常无桌面环境，首次运行可能无法打开浏览器。

   **解决方案**：
   - 在本地 Mac/Windows 运行首次验证
   - 将 `gongyizhan/.browser-profile/` 目录打包上传到青龙容器
   - 或使用 VNC 访问容器桌面

3. **添加定时任务**：
   ```
   20 8 * * * cd /ql/scripts && PLAYWRIGHT_HEADLESS=true node hyb-dashboard-playwright.js
   ```

---

## 🔧 故障排查

### 1. 会话过期

**症状**：自动运行时再次出现 CAP 验证

**解决**：重新执行首次运行步骤（`PLAYWRIGHT_HEADLESS=false`）

---

### 2. 选择器失效

**症状**：日志显示 "未找到签到按钮" 或 "未找到转盘按钮"

**原因**：网站 DOM 结构变化

**解决**：
1. 开启截图调试：
   ```bash
   PLAYWRIGHT_SCREENSHOT=true PLAYWRIGHT_HEADLESS=false node hyb-dashboard-playwright.js
   ```
2. 查看 `dashboard-before.png` 和 `error-screenshot.png`
3. 使用浏览器开发者工具检查实际的按钮选择器
4. 修改脚本中的 `checkinSelectors` 或 `wheelSelectors` 数组

---

### 3. Docker 环境无法启动浏览器

**症状**：`browserType.launchPersistentContext: Executable doesn't exist`

**解决**：
```bash
npx playwright install-deps chromium
npx playwright install chromium
```

---

### 4. 权限问题

**症状**：`EACCES: permission denied, mkdir '.browser-profile'`

**解决**：
```bash
chmod +x gongyizhan/hyb-dashboard-playwright.js
chmod -R 755 gongyizhan/.browser-profile
```

---

## 📊 日志说明

正常输出示例：

```
[hybgzs-dashboard-playwright] 启动 Playwright 持久化会话...
[hybgzs-dashboard-playwright] Profile 目录: /path/to/.browser-profile
[hybgzs-dashboard-playwright] Headless 模式: true
[hybgzs-dashboard-playwright] 浏览器已启动
[hybgzs-dashboard-playwright] 正在访问: https://cdk.hybgzs.com/dashboard
[hybgzs-dashboard-playwright] 页面加载完成
[hybgzs-dashboard-playwright] 开始自动化任务...
[hybgzs-dashboard-playwright] 开始执行签到...
[hybgzs-dashboard-playwright] 找到签到按钮: button:has-text("签到")
[hybgzs-dashboard-playwright] 已点击签到按钮，等待响应...
[hybgzs-dashboard-playwright] ✅ 签到成功
[hybgzs-dashboard-playwright] 开始执行大转盘...
[hybgzs-dashboard-playwright] 找到转盘按钮: button:has-text("转盘")
[hybgzs-dashboard-playwright] 第 1 次抽奖...
[hybgzs-dashboard-playwright]   中奖: 积分 +100
...
[hybgzs-dashboard-playwright] 转盘次数已用完，共抽取 50 次
[hybgzs-dashboard-playwright] ✅ 大转盘完成: 抽取 50 次，获得: 积分 +100, 流量 +1GB, ...
[hybgzs-dashboard-playwright] 
========================================
[hybgzs-dashboard-playwright] 📋 执行汇总
========================================
[hybgzs-dashboard-playwright] 签到: ✅ 签到成功
[hybgzs-dashboard-playwright] 转盘: ✅ 抽取 50 次，获得: ...
========================================
[hybgzs-dashboard-playwright] 浏览器已关闭
```

---

## ⚠️ 注意事项

1. **首次运行必须 `headless=false`**，否则无法完成人工验证
2. **会话有效期**：通常 7-30 天，过期后需重新验证
3. **并发限制**：不要同时运行多个实例，会话冲突导致失败
4. **选择器维护**：网站更新后可能需要调整按钮选择器
5. **Docker 环境**：确保安装了 Chromium 的系统依赖（libgbm, libnss3 等）

---

## 🔄 迁移指南

### 从 `hyb-dashboard.js` 迁移

**不需要删除原脚本**，两者可以共存：

- `hyb-dashboard.js` — 基于 HTTP API，遇到 CAP 时跳过
- `hyb-dashboard-playwright.js` — 基于浏览器自动化，首次验证后全自动

**推荐做法**：
1. 保留原脚本作为备份
2. 新增 Playwright 版本的定时任务
3. 观察运行稳定性后逐步替换

---

## 📞 技术支持

如遇问题，请提供以下信息：

1. 完整的控制台日志
2. 错误截图（如果开启了 `PLAYWRIGHT_SCREENSHOT`）
3. 运行环境（本地 / Docker / 青龙面板）
4. Playwright 版本（`npx playwright --version`）
