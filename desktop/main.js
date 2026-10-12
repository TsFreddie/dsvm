'use strict';
// dsvm desktop 后台脚本（package.json: main）。
// 职责：打开主窗口、常驻托盘、托盘菜单与窗口生命周期。
// 注意：托盘必须建在这里（background page，随应用生命周期常驻），
// 建在 index.html 里会在页面跳转/重载后被 GC（NW 官方文档明确建议）。

const fs = require('fs');
const os = require('os');
const path = require('path');

function dsvmHome() {
  return process.env.DSVM_HOME || path.join(os.homedir(), '.dsvm');
}

function settingsFile() {
  return path.join(dsvmHome(), 'desktop', 'settings.json');
}

const DEFAULT_SETTINGS = {
  minimizeToTray: false, // 最小化到托盘
  lightweightMode: false, // 轻量后台模式
  closeToMinimize: false, // 关闭时最小化
};

function loadSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return {
      minimizeToTray: parsed.minimizeToTray === true,
      lightweightMode: parsed.lightweightMode === true,
      closeToMinimize: parsed.closeToMinimize === true,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), `${JSON.stringify(settings, null, 2)}\n`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`dsvm desktop: cannot save settings: ${err.message}`);
  }
}

const settings = loadSettings();

// 常驻托盘：模块级持有，永不 remove（“始终启用”）。
let tray = null;
// 主窗口引用：托盘点击复用它，避免重复开窗。
let mainWin = null;

function iconPath(file) {
  // main.js 与图标同处应用目录，相对路径即可；被 link/解包后也能用绝对路径兜底。
  const local = path.join(__dirname, file);
  try {
    fs.accessSync(local);
    return local;
  } catch {
    return file;
  }
}

function buildTray() {
  try {
    tray = new nw.Tray({
      title: 'DeepSeek Harness (dsvm)',
      tooltip: 'DeepSeek Harness (dsvm)',
      icon: iconPath('tray.png'),
    });
  } catch (err) {
    // 极少数无托盘的环境：应用照常运行，只是没有托盘入口。
    // eslint-disable-next-line no-console
    console.error(`dsvm desktop: cannot create tray, continuing without it: ${err.message}`);
    return;
  }

  const menu = new nw.Menu();

  const minimizeItem = new nw.MenuItem({
    type: 'checkbox',
    label: '最小化到托盘',
    checked: settings.minimizeToTray,
  });
  minimizeItem.on('click', () => {
    settings.minimizeToTray = minimizeItem.checked;
    saveSettings(settings);
  });

  const lightweightItem = new nw.MenuItem({
    type: 'checkbox',
    label: '轻量后台模式',
    checked: settings.lightweightMode,
  });
  lightweightItem.on('click', () => {
    settings.lightweightMode = lightweightItem.checked;
    saveSettings(settings);
  });

  const closeItem = new nw.MenuItem({
    type: 'checkbox',
    label: '关闭时最小化',
    checked: settings.closeToMinimize,
  });
  closeItem.on('click', () => {
    settings.closeToMinimize = closeItem.checked;
    saveSettings(settings);
  });

  const quitItem = new nw.MenuItem({ type: 'normal', label: '退出' });
  quitItem.on('click', () => {
    nw.App.quit();
  });

  menu.append(minimizeItem);
  menu.append(lightweightItem);
  menu.append(closeItem);
  menu.append(new nw.MenuItem({ type: 'separator' }));
  menu.append(quitItem);
  tray.menu = menu;

  // 左键点击托盘：显示并聚焦主窗口（右键弹出上面的菜单）。
  tray.on('click', () => {
    if (mainWin !== null) {
      mainWin.show();
      mainWin.focus();
      return;
    }
    nw.Window.open('index.html', {}, (win) => {
      wireWindow(win);
      win.show();
      win.focus();
    });
  });
}

function wireWindow(win) {
  mainWin = win;
  // 应用内任何新窗口请求（webview 里 target=_blank 的外链等）：
  // 一律不另开窗口，转系统浏览器打开。
  win.on('new-win-policy', (frame, url, policy) => {
    try { policy.ignore(); } catch { /* ignore */ }
    try { nw.Shell.openExternal(url); } catch { /* ignore */ }
  });
  win.on('minimize', () => {
    if (settings.minimizeToTray) win.hide();
  });

  win.on('close', function () {
    // 不调 this.close(true) 即取消关闭。
    if (settings.closeToMinimize) {
      win.hide();
      return;
    }
    this.close(true);
  });

  win.on('closed', () => {
    mainWin = null;
    // 主窗口关掉后应用即退出（托盘随 background page 释放）。
    nw.App.quit();
  });
}

buildTray();

nw.Window.open('index.html', {}, (win) => {
  wireWindow(win);
  win.show();
  win.focus();
});
