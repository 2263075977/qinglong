# HYB Dashboard Playwright 青龙环境部署指南

## 问题诊断

错误信息：
```
browserType.launchPersistentContext: Executable doesn't exist at /root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome
```

**原因**：青龙 Docker 容器未安装 Playwright 的 Chromium 浏览器二进制文件。

---

## 解决方案（推荐顺序）

### 方案 1: 在青龙容器内安装 Playwright【推荐】

#### 步骤 1: 进入青龙容器

```bash
docker exec -it qinglong bash
```

#### 步骤 2: 进入项目目录

```bash
cd /ql/scripts
```

#### 步骤 3: 安装 Playwright 依赖

```bash
npm install playwright
```

#### 步骤 4: 安装 Chromium 浏览器 + 系统依赖

```bash
npx playwright install chromium --with-deps
```

**说明**：`--with-deps` 会自动安装系统依赖（libgbm, libnss3, libxcomposite 等）

#### 步骤 5: 验证安装

```bash
npx playwright --version
```

应该输出类似：
```
Version 1.40.0
```

---

### 方案 2: 如果方案 1 失败（系统依赖缺失）

某些轻量级 Docker 镜像缺少必要的系统库。手动安装：

#### Alpine Linux 容器

```bash
apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont
```

然后设置环境变量：
```bash
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser
```

#### Debian/Ubuntu 容器

```bash
apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2
```

然后重新运行：
```bash
npx playwright install chromium
```

---

### 方案 3: 使用本地会话迁移【最简单，但需定期更新】

如果青龙容器环境无法安装桌面依赖，可以在本地完成首次验证，然后上传会话文件：

#### 本地操作（Mac/Windows）

```bash
cd gongyizhan
node hyb-dashboard-playwright.js
# 手动完成验证，关闭浏览器
```

#### 打包会话目录

```bash
tar -czf browser-profile.tar.gz .browser-profile/
```

#### 上传到青龙容器

```bash
docker cp browser-profile.tar.gz qinglong:/ql/scripts/gongyizhan/
docker exec -it qinglong bash
cd /ql/scripts/gongyizhan
tar -xzf browser-profile.tar.gz
rm browser-profile.tar.gz
```

#### 配置定时任务（无头模式）

```bash
25 8 * * * cd /ql/scripts/gongyizhan && PLAYWRIGHT_HEADLESS=true node hyb-dashboard-playwright.js
```

⚠️ **注意**：会话有效期通常 7-30 天，过期后需重新上传。

---

## 验证部署

在青龙容器内运行：

```bash
cd /ql/scripts/gongyizhan
PLAYWRIGHT_HEADLESS=true node hyb-dashboard-playwright.js
```

**首次运行**（无会话）：
```bash
# 不设置 PLAYWRIGHT_HEADLESS，保持默认 false
node hyb-dashboard-playwright.js
```

如果容器无桌面环境，会报错。此时必须使用方案 3（本地会话迁移）。

---

## 常见错误处理

### 错误 1: `Protocol error (Target.setAutoAttach)`

**原因**: 无头模式下缺少必要的 X11 库

**解决**: 
```bash
export DISPLAY=:99
Xvfb :99 -screen 0 1280x720x24 &
```

或使用方案 3（本地会话迁移）。

---

### 错误 2: `browser.close: Target page, context or browser has been closed`

**原因**: 会话文件损坏或版本不匹配

**解决**:
```bash
rm -rf gongyizhan/.browser-profile
# 重新执行首次验证流程
```

---

### 错误 3: `net::ERR_TUNNEL_CONNECTION_FAILED`

**原因**: Docker 容器网络配置问题

**解决**: 检查 Docker 网络模式，确保容器可以访问外网：
```bash
docker exec -it qinglong ping -c 3 cdk.hybgzs.com
```

---

## 推荐配置（生产环境）

1. **优先使用方案 1**（容器内安装完整 Playwright）
2. **设置环境变量**（青龙面板 → 环境变量）:
   ```
   PLAYWRIGHT_HEADLESS=true
   ```
3. **定时任务配置**:
   ```
   25 8 * * * cd /ql/scripts/gongyizhan && node hyb-dashboard-playwright.js >> /ql/logs/hyb-dashboard-playwright.log 2>&1
   ```

---

## 故障排查命令

```bash
# 检查 Chromium 是否存在
ls -la /root/.cache/ms-playwright/chromium-*/chrome-linux64/chrome

# 检查系统依赖
ldd /root/.cache/ms-playwright/chromium-*/chrome-linux64/chrome | grep "not found"

# 查看详细日志
node hyb-dashboard-playwright.js 2>&1 | tee debug.log
```

---

需要进一步帮助请提供：
1. 青龙容器的基础镜像（`docker inspect qinglong | grep Image`）
2. 完整错误日志
3. 尝试过的解决方案
