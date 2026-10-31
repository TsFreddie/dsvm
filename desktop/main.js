'use strict';
// dsvm desktop 后台脚本（package.json: main）。
// 职责：打开主窗口、常驻托盘、托盘菜单与窗口生命周期。
// 注意：托盘必须建在这里（background page，随应用生命周期常驻），
// 建在 index.html 里会在页面跳转/重载后被 GC（NW 官方文档明确建议）。

const fs = require('fs');
const os = require('os');
const path = require('path');
const openExternalUrl = require('./open-external.js');

function dsvmHome() {
  return process.env.DSVM_HOME || path.join(os.homedir(), '.dsvm');
}

function settingsFile() {
  return path.join(dsvmHome(), 'desktop', 'settings.json');
}

const DEFAULT_SETTINGS = {
  minimizeToTray: false, // 最小化到托盘（依赖 minimize 事件，仅 x11）
  closeToTray: false, // 关闭到托盘
  lightweightMode: false, // 后台轻量模式
};

function loadSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return {
      minimizeToTray: parsed.minimizeToTray === true,
      // 旧键 closeToMinimize 迁移为 closeToTray。
      closeToTray: parsed.closeToTray === true || parsed.closeToMinimize === true,
      lightweightMode: parsed.lightweightMode === true,
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

// 窗口可见状态（最小化或被 hide 到托盘）：写 runtime-state.json 供 index.html
// 轮询（轻量模式的卸载依据）。OS 最小化走 minimize/restore 事件；
// 程序 hide()/show()（托盘/关闭逻辑）没有对应事件，调用处手动同步。
let minimized = false;

// 真正的 OS 最小化状态。hide() 到托盘也会把上面的 minimized 置 true，所以不能拿它
// 判断是否需要 restore()：对没有最小化的窗口调用 restore() 会把最大化状态一并还原。
let osMinimized = false;

function runtimeStateFile() {
  return path.join(dsvmHome(), 'desktop', 'runtime-state.json');
}

function publishMinimized() {
  try {
    fs.mkdirSync(path.dirname(runtimeStateFile()), { recursive: true });
    fs.writeFileSync(runtimeStateFile(), `${JSON.stringify({ minimized })}\n`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`dsvm desktop: cannot publish window state: ${err.message}`);
  }
}

function setMinimized(value) {
  if (minimized === value) return;
  minimized = value;
  publishMinimized();
}

// 常驻托盘：模块级持有，永不 remove（“始终启用”）。
let tray = null;
// 主窗口引用：托盘点击复用它，避免重复开窗。
let mainWin = null;

/**
 * Chromium 实际解析出的 ozone 平台（`--ozone-platform=wayland|x11`），
 * ground truth。非 Linux 或读不到时返回 null，上层退回环境变量判断。
 */
function effectiveOzonePlatform() {
  if (process.platform !== 'linux') return null;
  try {
    const cmdline = fs.readFileSync('/proc/self/cmdline', 'utf8');
    const match = cmdline.match(/--ozone-platform=([a-z0-9]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * 纯函数：按 ozone 开关 > 会话类型 > WAYLAND_DISPLAY 的优先级判定。
 * Chrome API 故意不暴露显示服务器（指纹原因），环境变量是标准通道。
 */
function detectWayland({ sessionType, waylandDisplay, nwPreArgs, ozonePlatform }) {
  if (ozonePlatform) return ozonePlatform === 'wayland';
  if (/(^|\s)--ozone-platform=wayland(\s|$)/.test(nwPreArgs || '')) return true;
  if (/(^|\s)--ozone-platform=x11(\s|$)/.test(nwPreArgs || '')) return false;
  if (sessionType === 'x11') return false;
  if (sessionType === 'wayland') return true;
  return Boolean(waylandDisplay);
}

/**
 * 当前窗口是否走原生 Wayland（ozone）。
 * xdg-shell 没有“被最小化”通知，NW 的 minimize/restore 事件在 Wayland 下不投递，
 * 所以“最小化到托盘”不建；close 事件和可见性都正常，因此“关闭到托盘”与
 * “后台轻量模式”照常提供。
 * manifest 用 --ozone-platform-hint=auto，因此只有显式 --ozone-platform 才算数。
 */
function isWaylandWindow() {
  return detectWayland({
    sessionType: process.env.XDG_SESSION_TYPE,
    waylandDisplay: process.env.WAYLAND_DISPLAY,
    nwPreArgs: process.env.NW_PRE_ARGS,
    ozonePlatform: effectiveOzonePlatform(),
  });
}

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
  const wayland = isWaylandWindow();

  // “最小化到托盘”依赖 minimize 事件，xdg-shell 不投递，所以只在非 Wayland 建。
  if (!wayland) {
    const minimizeItem = new nw.MenuItem({
      type: 'checkbox',
      label: '最小化到托盘',
      checked: settings.minimizeToTray,
    });
    minimizeItem.on('click', () => {
      // NW 在 emit 前已自动翻转 checked（见 menuitem.js handleEvent），这里以自身设置为准
      // 再显式回写，保证各后端显示一致。
      settings.minimizeToTray = !settings.minimizeToTray;
      minimizeItem.checked = settings.minimizeToTray;
      saveSettings(settings);
    });
    menu.append(minimizeItem);
  }

  // “关闭到托盘”只需要 close 事件，Wayland 同样投递；托盘入口因此在两个平台都可用。
  const closeItem = new nw.MenuItem({
    type: 'checkbox',
    label: '关闭到托盘',
    checked: settings.closeToTray,
  });
  closeItem.on('click', () => {
    settings.closeToTray = !settings.closeToTray;
    closeItem.checked = settings.closeToTray;
    saveSettings(settings);
  });
  menu.append(closeItem);

  // “后台轻量模式”只看窗口可见性（隐藏即开始计时），不依赖 minimize 事件。
  const lightweightItem = new nw.MenuItem({
    type: 'checkbox',
    label: '后台轻量模式',
    checked: settings.lightweightMode,
  });
  lightweightItem.on('click', () => {
    settings.lightweightMode = !settings.lightweightMode;
    lightweightItem.checked = settings.lightweightMode;
    saveSettings(settings);
  });
  menu.append(lightweightItem);

  const quitItem = new nw.MenuItem({ type: 'normal', label: '退出' });
  quitItem.on('click', () => {
    nw.App.quit();
  });

  menu.append(new nw.MenuItem({ type: 'separator' }));
  menu.append(quitItem);
  tray.menu = menu;

  // 左键点击托盘：显示并聚焦主窗口（右键弹出上面的菜单）。
  tray.on('click', () => {
    if (mainWin !== null) {
      revealMainWindow();
      return;
    }
    nw.Window.open('index.html', {}, (win) => {
      wireWindow(win);
      revealMainWindow();
    });
  });
}

/**
 * 把主窗口从后台带到前台。托盘点击和“应用被重复启动”共用这条路径，
 * 覆盖隐藏到托盘、OS 最小化、被其他窗口挡住这三种情况。
 * 顺序有讲究：最小化时 show() 不会解除最小化，所以先 restore()；最后再 focus()。
 */
function revealMainWindow() {
  const win = mainWin;
  if (win === null) return;
  if (osMinimized) {
    // 立刻清标志：旧版 NW 会同时触发 onOpen 和 on，重复调用时不要 restore 第二次
    // （Windows 上对刚恢复到最大化的窗口再 restore 一次会取消最大化）。
    osMinimized = false;
    try {
      win.restore();
    } catch (err) {
      console.error(`dsvm desktop: cannot restore window: ${err.message}`);
    }
  }
  try {
    win.show();
    setMinimized(false);
    win.focus();
  } catch (err) {
    console.error(`dsvm desktop: cannot show window: ${err.message}`);
  }
}

function wireWindow(win) {
  mainWin = win;
  // 应用内任何新窗口请求（webview 里 target=_blank 的外链等）：
  // 一律不另开窗口，转系统浏览器打开。
  win.on('new-win-policy', (frame, url, policy) => {
    try {
      policy.ignore();
    } catch (err) {
      console.error(`dsvm desktop: cannot ignore new window: ${err.message}`);
    }
    openExternalUrl(url);
  });
  win.on('minimize', () => {
    osMinimized = true;
    setMinimized(true);
    if (settings.minimizeToTray) win.hide();
  });

  win.on('restore', () => {
    osMinimized = false;
    setMinimized(false);
  });

  win.on('close', function () {
    // 不调 this.close(true) 即取消关闭。
    if (settings.closeToTray) {
      win.hide();
      setMinimized(true);
      return;
    }
    this.close(true);
  });

  win.on('closed', () => {
    mainWin = null;
    osMinimized = false;
    // 主窗口关掉后应用即退出（托盘随 background page 释放）。
    nw.App.quit();
  });
}

/**
 * 重复启动：NW 是单实例，第二次启动会把命令行转给已运行的实例，并触发 App 的
 * `open` 事件（macOS 点击 Dock 图标对应 `reopen`）。两者都只做一件事：
 * 把主窗口带到前台。
 */
function listenForRelaunch() {
  try {
    // 旧版 NW（< 0.111.2）的 App.on('open') 只触发一次（nwjs/nw.js#8283），
    // 维护者建议改用底层 onOpen 事件对象；两个入口都挂上，重复触发无副作用
    // （revealMainWindow 里的 osMinimized 会即时清位，restore 只会执行一次）。
    if (nw.App && nw.App.onOpen && typeof nw.App.onOpen.addListener === 'function') {
      nw.App.onOpen.addListener(revealMainWindow);
    }
    nw.App.on('open', revealMainWindow);
    nw.App.on('reopen', revealMainWindow);
  } catch (err) {
    console.error(`dsvm desktop: cannot listen for relaunches: ${err.message}`);
  }
}

// 单测入口（NW 运行时忽略 exports）。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { detectWayland, isWaylandWindow };
}

listenForRelaunch();
buildTray();
// 启动即发布一次，避免上次异常退出残留的 true 误导页面。
publishMinimized();

nw.Window.open('index.html', {}, (win) => {
  wireWindow(win);
  revealMainWindow();
});
