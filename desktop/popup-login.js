'use strict';
// webview 内 window.open 弹窗的接管逻辑。
//
// dsh 的“登录”会先 window.open('about:blank') 预开一个窗口，拿到 Host 返回的
// 授权 URL 后再 location.replace 过去。直接 discard 预开窗口会让登录退化成
// “复制链接”；把 about:blank 交给系统浏览器则会让 xdg-open/KIO 弹出
// “Could not read file about:blank” 错误。
//
// 因此：about:blank 的弹窗不 discard，而是 attach 到一个隐藏 webview，
// 跟踪它的首次真实导航；拿到授权 URL 后转给系统浏览器并销毁隐藏 webview。
// 其余带真实 URL 的弹窗（外链、意见反馈等）维持 discard + 系统浏览器。
//
// 依赖注入便于 node:test 单测（见 test/desktop-popup-login.test.ts）。
// index.html 与 main.js（bg）共用该文件（CommonJS）。

const BLANK_TARGETS = new Set(['', 'about:blank']);

/** about:blank/空串等“还没导航”的预开窗口 URL。 */
function isBlankTarget(url) {
  return url === undefined || url === null || BLANK_TARGETS.has(url);
}

function discardPopup(win, log) {
  try {
    if (win && typeof win.discard === 'function') win.discard();
  } catch (err) {
    log(`cannot discard popup: ${err.message}`);
  }
}

/**
 * 创建一个弹窗接管器。同一时间只跟踪一个预开窗口（dsh 每次登录前都会
 * dispose 掉上一个）。
 *
 * @param {object} deps
 * @param {() => { webview: object, dismiss: () => void }} deps.createHost
 *   创建隐藏 webview；webview 需支持 addEventListener/removeEventListener，
 *   dismiss 负责终止导航并移除宿主。
 * @param {(url: string) => void} deps.openExternalUrl
 * @param {(message: string) => void} [deps.log]
 */
function createPopupLogin({ createHost, openExternalUrl, log = () => {} }) {
  let tracked = null;

  /** 停止跟踪当前预开窗口，并销毁它的隐藏宿主。 */
  function release() {
    const current = tracked;
    if (!current) return;
    tracked = null;
    try {
      current.webview.removeEventListener('loadstart', current.onLoadstart);
    } catch (err) {
      log(`cannot detach popup host: ${err.message}`);
    }
    try {
      current.dismiss();
    } catch (err) {
      log(`cannot dismiss popup host: ${err.message}`);
    }
  }

  function followBlankPopup(popupWin) {
    release();
    let host;
    try {
      host = createHost();
    } catch (err) {
      log(`cannot create popup host: ${err.message}`);
      discardPopup(popupWin, log);
      return;
    }
    const onLoadstart = (event) => {
      const url = event ? event.url : undefined;
      if (isBlankTarget(url)) return;
      // 真实的授权 URL：转系统浏览器，隐藏宿主随 release 一起销毁。
      release();
      openExternalUrl(url);
    };
    host.webview.addEventListener('loadstart', onLoadstart);
    try {
      popupWin.attach(host.webview);
    } catch (err) {
      log(`cannot attach popup: ${err.message}`);
      try {
        host.webview.removeEventListener('loadstart', onLoadstart);
      } catch {
        // ignore
      }
      try {
        host.dismiss();
      } catch {
        // ignore
      }
      discardPopup(popupWin, log);
      return;
    }
    tracked = { webview: host.webview, onLoadstart, dismiss: host.dismiss };
  }

  /** 处理 webview 的 newwindow 事件；返回是否已消费。 */
  function handleNewWindow(event) {
    const target = event ? event.targetUrl : undefined;
    const popupWin = event ? event.window : null;
    if (!isBlankTarget(target)) {
      discardPopup(popupWin, log);
      if (target) openExternalUrl(target);
      return true;
    }
    followBlankPopup(popupWin);
    return true;
  }

  return { handleNewWindow, dispose: release };
}

module.exports = { createPopupLogin, isBlankTarget };
