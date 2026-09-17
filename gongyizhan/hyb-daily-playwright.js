/**
 * ⚠️ 伦理声明 / ETHICAL NOTICE ⚠️
 *
 * 此脚本仅供站长测试自己站点的防御强度使用。
 * This script is ONLY for site owners to test their own defenses.
 *
 * 禁止分发给其他用户 / DO NOT distribute to other users
 * 禁止用于破坏站点运营 / DO NOT use to harm site operations
 *
 * 如果你不是站长本人，请立即停止使用。
 * If you are not the site owner, stop using this immediately.
 *
 * 技术实现包含反自动化检测绕过，仅用于安全测试目的。
 * This implementation includes anti-automation bypass for security testing only.
 */

// new Env('黑与白福利站 每日任务 - Playwright 版')
// cron: 0 8 * * *

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

// ============================================================================
// BrowserAutomation 类 - 浏览器生命周期管理
// ============================================================================

class BrowserAutomation {
  constructor(cookie, options = {}) {
    this.cookie = cookie;
    this.options = {
      headless: process.env.HYB_HEADLESS !== 'false',
      debug: process.env.HYB_DEBUG === '1',
      blockResources: process.env.HYB_BLOCK_RESOURCES === '1',
      ...options,
    };
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async init() {
    console.log('🌐 正在启动浏览器...');

    // 1. 启动浏览器
    this.browser = await chromium.launch({
      headless: this.options.headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--disable-default-apps',
        '--no-first-run',
        '--no-zygote',
      ],
    });

    // 2. 创建上下文
    this.context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });

    // 3. 注入 Cookie
    const cookies = this._parseCookie(this.cookie);
    await this.context.addCookies(cookies);

    if (this.options.debug) {
      console.log(`[Debug] 注入了 ${cookies.length} 个 Cookie`);
    }

    // 4. 创建页面
    this.page = await this.context.newPage();

    // 5. 监听 console（调试模式）
    if (this.options.debug) {
      this.page.on('console', msg => console.log('[Browser]', msg.text()));
    }

    // 6. 可选：阻止资源加载
    if (this.options.blockResources) {
      await this.context.route('**/*', (route) => {
        const resourceType = route.request().resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
          route.abort();
        } else {
          route.continue();
        }
      });
    }

    console.log('✓ 浏览器启动成功');
  }

  _parseCookie(cookieString) {
    const cookies = [];
    const pairs = cookieString.split(';').map(s => s.trim());

    for (const pair of pairs) {
      const [name, ...valueParts] = pair.split('=');
      const value = valueParts.join('=');

      if (!name || !value) continue;

      cookies.push({
        name: name.trim(),
        value: value.trim(),
        domain: 'cdk.hybgzs.com',
        path: '/',
        secure: true,
        httpOnly: name.includes('Secure') || name.includes('Host'),
      });
    }

    return cookies;
  }

  async navigate(url) {
    if (this.options.debug) {
      console.log(`[Debug] 导航到：${url}`);
    }
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  getPage() {
    return this.page;
  }

  async screenshot(name) {
    const timestamp = Date.now();
    const path = `/tmp/hyb-${name}-${timestamp}.png`;

    try {
      await this.page.screenshot({ path, fullPage: true });
      console.log(`[Screenshot] 已保存：${path}`);
      return path;
    } catch (e) {
      console.error(`[Screenshot] 截图失败：${e.message}`);
      return null;
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }
}

// ============================================================================
// CapWidgetHelper 类 - Cap 验证通用等待逻辑
// ============================================================================

class CapWidgetHelper {
  constructor(page, options = {}) {
    this.page = page;
    this.timeout = options.timeout || 30000;
  }

  async needsCaptcha(timeout = 3000) {
    try {
      await this.page.waitForSelector('button:has-text("点击验证")', { timeout });
      return true;
    } catch (e) {
      return false;
    }
  }

  async solveCaptcha() {
    const startTime = Date.now();

    try {
      // 1. 等待验证按钮出现
      await this.page.waitForSelector('button:has-text("点击验证")', {
        timeout: 10000,
      });

      console.log('  → 检测到 Cap 验证按钮，准备点击...');

      // 2. 随机延迟（模拟真实用户）
      const delay = Math.random() * 1000 + 500;
      await this.page.waitForTimeout(delay);

      // 3. 点击验证按钮
      await this.page.click('button:has-text("点击验证")');

      console.log('  → 已点击验证，等待 Widget 自动解题...');

      // 4. 等待 Widget 完成（主要方式：DOM 属性）
      try {
        await this.page.waitForSelector('.captcha[data-state="done"]', {
          timeout: this.timeout,
        });
      } catch (e) {
        // 备用方式：按钮文字变化
        await this.page.waitForSelector('button:has-text("你是真人")', {
          timeout: 5000,
        });
      }

      const elapsed = Date.now() - startTime;
      console.log(`  ✓ Cap 验证完成，耗时 ${elapsed}ms`);

      // 5. 短暂延迟让页面状态稳定
      await this.page.waitForTimeout(500);

      return { success: true, elapsed };

    } catch (error) {
      const elapsed = Date.now() - startTime;
      throw new Error(`Cap 验证失败（耗时 ${elapsed}ms）：${error.message}`);
    }
  }
}

// ============================================================================
// 工具函数
// ============================================================================

function loadCookie() {
  const envKeys = ['HYB_COOKIE', 'HYB_DASHBOARD_COOKIE', 'HYBGZS_COOKIE'];

  for (const key of envKeys) {
    const value = process.env[key];
    if (value) {
      let cleaned = value.replace(/^Cookie:\s*/i, '').trim();
      cleaned = cleaned.replace(/^["']|["']$/g, '');
      return cleaned;
    }
  }

  throw new Error(
    '❌ 未找到 Cookie 环境变量\n请设置以下任一变量：\n  - HYB_COOKIE\n  - HYB_DASHBOARD_COOKIE\n  - HYBGZS_COOKIE'
  );
}

function sanitizeLog(message) {
  // 脱敏 Cookie
  message = message.replace(/(__Secure-[^=]+)=([^;]{10})[^;]*/g, '$1=$2***');
  message = message.replace(/(__Host-[^=]+)=([^;]{10})[^;]*/g, '$1=$2***');

  // 脱敏 JWT
  message = message.replace(/(eyJ[A-Za-z0-9_-]{10})[A-Za-z0-9_.-]+/g, '$1***');

  return message;
}

async function checkBrowserInstalled() {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch (e) {
    if (e.message.includes('Executable doesn\'t exist')) {
      console.error('❌ 未检测到 Chromium 浏览器');
      console.error('');
      console.error('请按以下步骤安装：');
      console.error('  1. 进入青龙容器：docker exec -it qinglong bash');
      console.error('  2. 进入脚本目录：cd /ql/scripts');
      console.error('  3. 安装浏览器：npx playwright install chromium');
      console.error('');
      console.error('或者在宿主机运行：');
      console.error('  ./install-browser.sh');
      return false;
    }
    throw e;
  }
}

// ============================================================================
// 业务流程：访问打卡（HTTP 方式）
// ============================================================================

async function performVisit(cookie) {
  console.log('\n📅 开始访问打卡...');

  try {
    const response = await fetch('https://cdk.hybgzs.com/api/visit', {
      method: 'POST',
      headers: {
        'Cookie': cookie,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    if (data.success) {
      console.log('✅ 访问打卡成功');
      return { success: true, message: data.message || '访问打卡完成' };
    } else {
      throw new Error(data.message || '访问打卡失败');
    }
  } catch (error) {
    console.error(`❌ 访问打卡失败：${error.message}`);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// 业务流程：每日签到
// ============================================================================

async function performCheckin(browser) {
  console.log('\n🎁 开始每日签到...');

  const page = browser.getPage();

  try {
    // 1. 导航到签到页
    console.log('  → 访问签到页面...');
    await browser.navigate('https://cdk.hybgzs.com/gas-station/checkin');

    // 2. 等待页面加载
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000); // 等待动态内容

    // 3. 检查是否需要 Cap 验证
    const capHelper = new CapWidgetHelper(page);

    if (await capHelper.needsCaptcha(5000)) {
      console.log('  → 检测到 Cap 验证，开始自动解题...');
      const capResult = await capHelper.solveCaptcha();
      console.log(`  ✓ Cap 验证完成（耗时 ${capResult.elapsed}ms）`);
    } else {
      console.log('  ✓ 无需 Cap 验证');
    }

    // 4. 等待签到按钮
    await page.waitForSelector('button:has-text("签到")', { timeout: 10000 });

    // 5. 点击签到
    console.log('  → 点击签到按钮...');
    await page.click('button:has-text("签到")');

    // 6. 等待成功提示
    const successSelector = '.toast:has-text("签到成功"), .message:has-text("签到成功"), text=签到成功';
    await page.waitForSelector(successSelector, { timeout: 10000 });

    // 7. 提取奖励信息
    const messageElement = await page.locator(successSelector).first();
    const message = await messageElement.textContent();

    // 8. 解析奖励
    const rewardMatch = message.match(/获得\s*(\d+)\s*积分/);
    const reward = rewardMatch ? parseInt(rewardMatch[1]) : 0;

    const daysMatch = message.match(/连续\s*(\d+)\s*天/);
    const consecutiveDays = daysMatch ? parseInt(daysMatch[1]) : 0;

    console.log(`✅ 签到成功：${message.trim()}`);

    return {
      success: true,
      message: message.trim(),
      reward,
      consecutiveDays,
    };

  } catch (error) {
    // 截图保存错误现场
    const screenshotPath = await browser.screenshot(`checkin-error-${Date.now()}`);
    console.error(`❌ 签到失败：${error.message}`);
    if (screenshotPath) {
      console.error(`   截图已保存：${screenshotPath}`);
    }

    return {
      success: false,
      error: error.message,
      screenshot: screenshotPath,
    };
  }
}

// ============================================================================
// 业务流程：幸运转盘
// ============================================================================

async function performWheel(browser) {
  console.log('\n🎰 开始幸运转盘...');

  const page = browser.getPage();
  const prizes = [];

  try {
    // 1. 导航到转盘页
    console.log('  → 访问转盘页面...');
    await browser.navigate('https://cdk.hybgzs.com/gas-station/wheel');

    // 2. 等待页面加载
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);

    // 3. 循环抽奖
    let spinCount = 0;
    const maxSpins = 10; // 安全上限

    while (spinCount < maxSpins) {
      // 3.1 读取剩余次数
      try {
        const remainingElement = await page.locator('.remaining-spins, .spins-left, text=/剩余.*次/').first();
        const remainingText = await remainingElement.textContent();
        const remaining = parseInt(remainingText.match(/\d+/)?.[0] || '0');

        console.log(`  → 剩余次数：${remaining}`);

        if (remaining === 0) {
          console.log('✅ 抽奖次数已用完');
          break;
        }
      } catch (e) {
        // 无法读取剩余次数，尝试直接抽奖
        console.log('  ⚠ 无法读取剩余次数，尝试继续抽奖...');
      }

      // 3.2 检查是否需要 Cap 验证
      const capHelper = new CapWidgetHelper(page);

      if (await capHelper.needsCaptcha(3000)) {
        console.log(`  → [第 ${spinCount + 1} 次] 检测到 Cap 验证...`);
        const capResult = await capHelper.solveCaptcha();
        console.log(`  ✓ Cap 验证完成（耗时 ${capResult.elapsed}ms）`);
      }

      // 3.3 点击抽奖按钮
      console.log(`  → [第 ${spinCount + 1} 次] 点击抽奖按钮...`);
      await page.click('button:has-text("抽奖"), button:has-text("立即抽奖")');

      // 3.4 等待抽奖结果
      await page.waitForTimeout(2000); // 等待转盘动画

      const prizeSelector = '.prize-result, .wheel-result, text=/获得|谢谢参与/';
      await page.waitForSelector(prizeSelector, { timeout: 10000 });

      // 3.5 提取奖品信息
      const prizeElement = await page.locator(prizeSelector).first();
      const prizeText = await prizeElement.textContent();
      const prize = prizeText.trim();

      prizes.push(prize);
      console.log(`  ✓ 获得奖品：${prize}`);

      // 3.6 关闭弹窗
      try {
        await page.click('button:has-text("确定"), button:has-text("关闭"), .close-button', { timeout: 2000 });
      } catch (e) {
        // 无弹窗或自动关闭
      }

      // 3.7 短暂延迟
      await page.waitForTimeout(1000);

      spinCount++;
    }

    console.log(`✅ 转盘完成，共抽取 ${prizes.length} 次`);

    return {
      success: true,
      prizes,
      totalSpins: prizes.length,
    };

  } catch (error) {
    // 截图保存错误现场
    const screenshotPath = await browser.screenshot(`wheel-error-${Date.now()}`);
    console.error(`❌ 转盘失败：${error.message}`);
    if (screenshotPath) {
      console.error(`   截图已保存：${screenshotPath}`);
    }

    // 返回已抽到的奖品
    return {
      success: false,
      error: error.message,
      prizes,
      totalSpins: prizes.length,
      screenshot: screenshotPath,
    };
  }
}

// ============================================================================
// 通知格式化
// ============================================================================

function formatSuccessNotification(results) {
  let message = '✅ 黑与白每日任务完成\n\n';

  // 访问打卡
  if (results.visit?.success) {
    message += '📅 访问打卡：成功\n';
  } else {
    message += `📅 访问打卡：失败（${results.visit?.error || '未知错误'}）\n`;
  }

  // 每日签到
  if (results.checkin?.success) {
    message += `🎁 每日签到：${results.checkin.message}\n`;
    if (results.checkin.consecutiveDays > 0) {
      message += `   连续签到 ${results.checkin.consecutiveDays} 天\n`;
    }
  } else {
    message += `🎁 每日签到：失败（${results.checkin?.error || '未知错误'}）\n`;
  }

  // 幸运转盘
  if (results.wheel?.totalSpins > 0) {
    message += `🎰 幸运转盘：共抽取 ${results.wheel.totalSpins} 次\n`;
    results.wheel.prizes.forEach((prize, index) => {
      message += `   ${index + 1}. ${prize}\n`;
    });
  } else {
    message += '🎰 幸运转盘：无剩余次数或失败\n';
  }

  return message;
}

function formatErrorNotification(error, results) {
  let message = '❌ 黑与白每日任务失败\n\n';

  message += `错误信息：${error.message}\n\n`;

  // 已完成的任务
  if (results.visit?.success) {
    message += '✓ 访问打卡：已完成\n';
  }
  if (results.checkin?.success) {
    message += '✓ 每日签到：已完成\n';
  }

  // 错误建议
  message += '\n建议：\n';

  if (error.message.includes('Cookie')) {
    message += '· 请更新 HYB_COOKIE 环境变量\n';
  } else if (error.message.includes('Chromium')) {
    message += '· 请安装 Chromium 浏览器：npx playwright install chromium\n';
  } else if (error.message.includes('Cap')) {
    message += '· Cap 验证失败，可能是网络问题或 Stealth 插件失效\n';
    message += '· 请查看青龙日志中的截图路径\n';
  } else if (error.message.includes('Timeout') || error.message.includes('timeout')) {
    message += '· 页面加载超时，请检查网络连接\n';
  } else {
    message += '· 页面结构可能已变更，请联系脚本维护者\n';
  }

  return message;
}

// ============================================================================
// 主函数
// ============================================================================

async function main() {
  console.log('🚀 黑与白福利站 每日任务开始（Playwright 版）\n');

  const results = {
    visit: null,
    checkin: null,
    wheel: null,
  };

  let browser = null;

  try {
    // 1. 加载 Cookie
    const cookie = loadCookie();
    console.log(`✓ Cookie 已加载：${sanitizeLog(cookie.substring(0, 50))}...`);

    // 2. 检测浏览器
    console.log('✓ 正在检测 Chromium 浏览器...');
    const browserInstalled = await checkBrowserInstalled();
    if (!browserInstalled) {
      throw new Error('Chromium 浏览器未安装');
    }
    console.log('✓ Chromium 浏览器已就绪\n');

    // 3. 访问打卡（HTTP 方式，不需要浏览器）
    results.visit = await performVisit(cookie);

    // 4. 启动浏览器
    console.log('\n🌐 正在启动浏览器...');
    browser = new BrowserAutomation(cookie);
    await browser.init();
    console.log('✓ 浏览器启动成功\n');

    // 5. 每日签到
    results.checkin = await performCheckin(browser);

    // 6. 幸运转盘
    results.wheel = await performWheel(browser);

  } catch (error) {
    console.error(`\n❌ 任务执行失败：${error.message}`);

    // 发送失败通知
    const notification = formatErrorNotification(error, results);
    await sendNotify('黑与白每日任务失败', notification);

    process.exit(1);

  } finally {
    // 7. 关闭浏览器
    if (browser) {
      console.log('\n🔒 关闭浏览器...');
      await browser.close();
      console.log('✓ 浏览器已关闭');
    }
  }

  // 8. 发送成功通知
  const notification = formatSuccessNotification(results);
  await sendNotify('黑与白每日任务完成', notification);

  console.log('\n✅ 所有任务执行完成！');
}

// ============================================================================
// sendNotify 集成（青龙面板）
// ============================================================================

async function sendNotify(title, content) {
  try {
    // 尝试导入青龙的 sendNotify 模块
    const { sendNotify: notify } = await import('./sendNotify.js');
    await notify(title, content);
  } catch (e) {
    // 如果没有 sendNotify 模块，只输出到控制台
    console.log('\n--- 通知内容 ---');
    console.log(`标题：${title}`);
    console.log(`内容：\n${content}`);
    console.log('--- 通知结束 ---\n');
  }
}

// ============================================================================
// 入口
// ============================================================================

main().catch(error => {
  console.error('未捕获的错误：', error);
  process.exit(1);
});

