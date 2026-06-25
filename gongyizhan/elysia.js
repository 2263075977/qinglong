'use strict';
/**
 * cron: 15 8 * * *
 * new Env('Elysia 签到');
 *
 * 环境变量: ELYSIA_ACCOUNTS (Cookie)
 */

const { chromium } = require('playwright');

// 配置
const CONFIG = {
  URL: 'https://elysia.h-e.top/console/personal',
  ENV: 'ELYSIA_ACCOUNTS',
  USER_ID: '944',
  HEADLESS: true,
  TIMEOUT: 20000,
};

// 工具函数
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseCookie(str) {
  const cookies = {};
  str.split(';').forEach(pair => {
    const [k, ...v] = pair.trim().split('=');
    if (k) cookies[k] = v.join('=');
  });
  return cookies;
}

function getNotify() {
  try {
    const notify = require('./sendNotify');
    return notify?.sendNotify || notify;
  } catch {
    return (title, msg) => console.log(`\n${title}\n${msg}`);
  }
}

// 响应分析
function analyzeResponse(res) {
  const { status, data } = res;
  const text = typeof data === 'string' ? data : JSON.stringify(data);

  if (text.includes('<!doctype html>') || text.includes('bot detection')) {
    return { type: 'auth_failed', message: 'Cookie 已失效或被 Cloudflare 拦截' };
  }

  try {
    const json = typeof data === 'object' ? data : JSON.parse(data);

    if (json.success === true) {
      const quota = json.data?.quota_awarded?.toLocaleString();
      return { type: 'success', message: quota ? `签到成功，获得 ${quota} 配额` : '签到成功' };
    }

    const msg = json.message || '';
    if (msg.includes('已签到') || msg.includes('already')) {
      return { type: 'already_checked', message: '今日已签到' };
    }

    if (status === 401 || msg.includes('无权')) {
      return { type: 'auth_failed', message: `Cookie 已失效: ${msg}` };
    }

    return { type: 'error', message: `签到失败: ${msg}` };
  } catch {
    return { type: 'error', message: '无法解析响应' };
  }
}

// 浏览器签到
async function checkin(cookie) {
  let browser, context, page;

  try {
    const execPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium';

    browser = await chromium.launch({
      headless: CONFIG.HEADLESS,
      executablePath: execPath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      locale: 'zh-CN',
    });

    const cookies = parseCookie(cookie);
    await context.addCookies(
      Object.entries(cookies).map(([name, value]) => ({
        name, value, domain: '.h-e.top', path: '/',
      }))
    );

    page = await context.newPage();

    // 注入请求头
    await page.route('**/*', (route) => {
      const headers = route.request().headers();
      headers['new-api-user'] = CONFIG.USER_ID;
      route.continue({ headers });
    });

    // 监听签到响应
    let response = null;
    page.on('response', async (res) => {
      if (res.url().includes('/api/user/checkin')) {
        response = { status: res.status(), data: await res.text().catch(() => '') };
      }
    });

    await page.goto(CONFIG.URL, { waitUntil: 'domcontentloaded', timeout: CONFIG.TIMEOUT });
    await sleep(1500);

    // 检查 Cloudflare
    if ((await page.content()).includes('bot detection')) {
      await sleep(5000);
    }

    // 查找签到按钮
    const btn = page.locator('button:has-text("签到")').first();
    if (await btn.count() > 0) {
      await btn.click();
      await sleep(2000);
    } else {
      await page.evaluate(() => fetch('/api/user/checkin', { method: 'POST' }));
      await sleep(1500);
    }

    return response ? analyzeResponse(response) : { type: 'error', message: '未捕获响应' };

  } catch (err) {
    return { type: 'error', message: err.message };
  } finally {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

// 主流程
async function main() {
  console.log(`开始执行... ${new Date().toLocaleString('zh-CN')}\n`);

  const notify = getNotify();
  const cookie = process.env[CONFIG.ENV];

  if (!cookie?.trim()) {
    const msg = `未配置 ${CONFIG.ENV}`;
    console.log(msg);
    await notify('Elysia 自动签到', `❌ ${msg}`);
    return;
  }

  console.log('签到中...');
  const result = await checkin(cookie.trim());

  let notifyContent = '';
  if (result.type === 'success') {
    notifyContent = `✅ ${result.message}`;
  } else if (result.type === 'already_checked') {
    notifyContent = '⏭️ 今日已签到';
  } else {
    notifyContent = `❌ ${result.message}`;
  }

  console.log(notifyContent);
  console.log(`\n完成 ${new Date().toLocaleString('zh-CN')}`);
  await notify('Elysia 自动签到', notifyContent);
}

main().catch(async (err) => {
  console.error(`异常: ${err.message}`);
  try {
    await getNotify()('Elysia 自动签到', `❌ 执行异常: ${err.message}`);
  } catch {}
  process.exitCode = 1;
});
