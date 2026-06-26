#!/usr/bin/env node
/**
 * cron: 5 8 * * *
 * new Env('AnyRouter 签到');
 *
 * 环境变量: ANYROUTER_COOKIE="session=xxx; acw_tc=xxx; acw_sc__v2=xxx"
 */

const SITE_URL = 'https://anyrouter.top';
const USER_ID = '68910';

// 青龙通知
async function notify(title, content) {
  try {
    const sendNotify = require('./sendNotify');
    await sendNotify.sendNotify(title, content);
  } catch {
    console.log(`\n📢 ${title}\n${content}`);
  }
}

async function main() {
  const cookie = process.env.ANYROUTER_COOKIE;

  if (!cookie) {
    console.log('❌ 未配置环境变量 ANYROUTER_COOKIE');
    await notify('AnyRouter 自动签到', '❌ 未配置环境变量');
    process.exit(1);
  }

  console.log('🎁 AnyRouter 自动登录领奖\n');

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
      console.log('❌ Cookie 已失效');
      await notify('AnyRouter 自动签到', '❌ Cookie 已失效');
      process.exit(1);
    }

    const data = JSON.parse(text);

    if (!data.success || !data.data) {
      const msg = data.message || '未知错误';
      console.log(`❌ 登录失败: ${msg}`);
      await notify('AnyRouter 自动签到', `❌ 登录失败: ${msg}`);
      process.exit(1);
    }

    const quota = (data.data.quota || 0) / 500000;
    const used = (data.data.used_quota || 0) / 500000;
    const balance = quota - used;
    const todayIncome = data.data.today_income !== undefined
      ? (data.data.today_income / 500000)
      : null;

    console.log('✅ 登录成功！');
    console.log(`💰 余额: ${balance.toFixed(4)} 元`);
    if (todayIncome !== null) {
      console.log(`🎁 今日收益: ${todayIncome.toFixed(4)} 元`);
    }

    const message = todayIncome !== null && todayIncome > 0
      ? `✅ 签到成功，今日收益: ${todayIncome.toFixed(4)} 元\n\n余额: ${balance.toFixed(4)} 元`
      : `✅ 登录成功\n\n余额: ${balance.toFixed(4)} 元`;

    await notify('AnyRouter 自动签到', message);

  } catch (error) {
    console.error(`❌ 请求失败: ${error.message}`);
    await notify('AnyRouter 自动签到', `❌ 请求失败: ${error.message}`);
    process.exit(1);
  }
}

main().catch(console.error);
