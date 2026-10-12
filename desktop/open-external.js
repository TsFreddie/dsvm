'use strict';
// 系统浏览器打开：Linux 下不用 nw.Shell.openExternal（它可能绕过 PATH
// 调绝对路径的 opener，在测试/特殊环境里静默失败），改用 Node spawn
// 走 PATH 查找（BROWSER > xdg-open），与 dsvm open 保持一致；
// Windows/macOS 仍用 Shell.openExternal。
// index.html 与 main.js（bg）共用：require('./open-external.js')。

const { spawn } = require('child_process');

module.exports = function openExternalUrl(url) {
  if (process.platform === 'linux') {
    const opener = process.env.BROWSER || 'xdg-open';
    let child;
    try {
      child = spawn(opener, [url], { detached: true, stdio: 'ignore' });
    } catch (err) {
      console.error(`dsvm desktop: cannot launch ${opener}: ${err.message}`);
      return;
    }
    child.once('error', (err) => {
      console.error(`dsvm desktop: cannot launch ${opener}: ${err.message}`);
    });
    child.unref();
    return;
  }
  try {
    nw.Shell.openExternal(url);
  } catch (err) {
    console.error(`dsvm desktop: cannot open external URL: ${err.message}`);
  }
};
