#!/usr/bin/env node
/**
 * cron: 5 8 * * *
 * new Env('AnyRouter 签到');
 *
 * 环境变量: ANYROUTER_COOKIE="session=xxx; acw_tc=xxx; acw_sc__v2=xxx"
 */

const SITE_URL = 'https://anyrouter.top';
const USER_ID = '68910';
const QUOTA_PER_YUAN = 500000;

// 青龙通知
async function notify(title, content) {
  try {
    const mod = require('./sendNotify');
    const sendNotify = typeof mod === 'function'
      ? mod
      : typeof mod?.sendNotify === 'function'
        ? mod.sendNotify
        : typeof mod?.default === 'function'
          ? mod.default
          : null;

    if (sendNotify) {
      return await Promise.resolve(sendNotify(title, content));
    }
  } catch (error) {
    console.error(`[AnyRouter] 青龙通知发送失败: ${error.message}`);
  }

  console.log(`\n${title}\n${content}`);
  return false;
}

function quotaToYuan(quota) {
  const value = Number(quota);
  if (!Number.isFinite(value)) {
    return 0;
  }

  return value / QUOTA_PER_YUAN;
}

async function main() {
  const cookie = process.env.ANYROUTER_COOKIE;

  if (!cookie) {
    await notify('AnyRouter 自动签到', '❌ 未配置环境变量');
    process.exit(1);
  }

  try {
    const response = await fetch(`${SITE_URL}/api/user/self`, {
      headers: {
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'New-Api-User': USER_ID,
        'Veloera-User': USER_ID,
        'User-id': USER_ID
      }
    });

    const text = await response.text();

    if (text.includes('<html') || text.includes('<script')) {
      await notify('AnyRouter 自动签到', '❌ Cookie 已失效');
      process.exit(1);
    }

    const data = JSON.parse(text);

    if (!data.success || !data.data) {
      const msg = data.message || '未知错误';
      await notify('AnyRouter 自动签到', `❌ 登录失败: ${msg}`);
      process.exit(1);
    }

    const balance = quotaToYuan(data.data.quota);
    const todayIncome = data.data.today_income !== undefined
      ? quotaToYuan(data.data.today_income)
      : null;

    const message = todayIncome !== null && todayIncome > 0
      ? `✅ 签到成功，今日收益: ${todayIncome.toFixed(4)} 元\n\n余额: ${balance.toFixed(4)} 元`
      : `✅ 登录成功\n\n余额: ${balance.toFixed(4)} 元`;

    await notify('AnyRouter 自动签到', message);

  } catch (error) {
    await notify('AnyRouter 自动签到', `❌ 请求失败: ${error.message}`);
    process.exit(1);
  }
}

main().catch(async (error) => {
  await notify('AnyRouter 自动签到', `❌ 执行异常: ${error.message}`);
  process.exitCode = 1;
});
