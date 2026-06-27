'use strict';

const fs = require('fs');
const path = require('path');

function isSameFile(file) {
  try {
    return fs.realpathSync(file) === fs.realpathSync(__filename);
  } catch {
    return false;
  }
}

function getQinglongNotifyModule() {
  const candidates = [
    path.join(process.cwd(), 'sendNotify.js'),
    path.join(process.cwd(), 'notify.js'),
    path.join(process.cwd(), 'function', 'sendNotify.js'),
    path.join(process.cwd(), 'function', 'notify.js'),
    path.join(__dirname, '..', 'sendNotify.js'),
    path.join(__dirname, '..', 'notify.js'),
    path.join('/ql', 'data', 'scripts', 'sendNotify.js'),
    path.join('/ql', 'data', 'scripts', 'notify.js'),
    path.join('/ql', 'scripts', 'sendNotify.js'),
    path.join('/ql', 'scripts', 'notify.js'),
  ];

  for (const file of [...new Set(candidates)]) {
    if (!fs.existsSync(file) || isSameFile(file)) continue;

    try {
      const mod = require(file);
      const sendNotify = typeof mod === 'function'
        ? mod
        : typeof mod?.sendNotify === 'function'
          ? mod.sendNotify
          : typeof mod?.default === 'function'
            ? mod.default
            : null;

      if (sendNotify) {
        return { sendNotify, file };
      }
    } catch (error) {
      console.error(`[sendNotify] 加载青龙通知模块失败: ${file}`);
      console.error(`[sendNotify] 错误: ${error.message}`);
    }
  }

  return null;
}

async function sendNotify(title, content) {
  const notify = getQinglongNotifyModule();

  if (!notify) {
    console.log(`\n${title}\n${content}`);
    return false;
  }

  try {
    await Promise.resolve(notify.sendNotify(title, content));
    return true;
  } catch (error) {
    console.error(`[sendNotify] 青龙通知发送失败: ${error.message}`);
    console.log(`\n${title}\n${content}`);
    return false;
  }
}

module.exports = sendNotify;
module.exports.sendNotify = sendNotify;
module.exports.getQinglongNotifyModule = getQinglongNotifyModule;
