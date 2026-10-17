import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PROJECT_ROOT } from './helpers.js';

interface FakeHost {
  webview: FakeWebview;
  dismissCount: number;
  dismiss: () => void;
}

interface FakePopupWindow {
  attached: FakeWebview[];
  discarded: number;
  attachThrows: boolean;
  attach: (webview: FakeWebview) => void;
  discard: () => void;
}

interface PopupLogin {
  createPopupLogin: (deps: {
    createHost: () => { webview: FakeWebview; dismiss: () => void };
    openExternalUrl: (url: string) => void;
    log?: (message: string) => void;
  }) => {
    handleNewWindow: (event: { targetUrl?: string; window: FakePopupWindow | null }) => boolean;
    dispose: () => void;
  };
  isBlankTarget: (url: string | null | undefined) => boolean;
}

const require = createRequire(import.meta.url);
const popupLogin = require(join(PROJECT_ROOT, 'desktop', 'popup-login.js')) as PopupLogin;

type Listener = (event: { url?: string }) => void;

class FakeWebview {
  private listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, fn: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  emit(type: string, event: { url?: string }): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

function fakePopup(): FakePopupWindow {
  const popup: FakePopupWindow = {
    attached: [],
    discarded: 0,
    attachThrows: false,
    attach: (webview: FakeWebview) => {
      if (popup.attachThrows) throw new Error('attach failed');
      popup.attached.push(webview);
    },
    discard: () => {
      popup.discarded += 1;
    },
  };
  return popup;
}

function setup(options: { createHostThrows?: boolean } = {}) {
  const hosts: FakeHost[] = [];
  const opened: string[] = [];
  const logs: string[] = [];
  const controller = popupLogin.createPopupLogin({
    createHost: () => {
      if (options.createHostThrows) throw new Error('no host');
      const webview = new FakeWebview();
      const host: FakeHost = {
        webview,
        dismissCount: 0,
        dismiss: () => {
          host.dismissCount += 1;
        },
      };
      hosts.push(host);
      return host;
    },
    openExternalUrl: (url: string) => opened.push(url),
    log: (message: string) => logs.push(message),
  });
  return { controller, hosts, opened, logs };
}

test('isBlankTarget: 预开窗口只认 about:blank/空值，真实 URL 不算', () => {
  assert.equal(popupLogin.isBlankTarget('about:blank'), true);
  assert.equal(popupLogin.isBlankTarget(''), true);
  assert.equal(popupLogin.isBlankTarget(undefined), true);
  assert.equal(popupLogin.isBlankTarget(null), true);
  assert.equal(popupLogin.isBlankTarget('https://platform.deepseek.com/dsh/authorize'), false);
});

test('有真实 URL 的弹窗照旧 discard 并转系统浏览器', () => {
  const { controller, hosts, opened } = setup();
  const popup = fakePopup();
  assert.equal(
    controller.handleNewWindow({ targetUrl: 'https://example.com/page', window: popup }),
    true,
  );
  assert.equal(popup.discarded, 1);
  assert.deepEqual(popup.attached, [], '外链不 attach');
  assert.deepEqual(opened, ['https://example.com/page']);
  assert.equal(hosts.length, 0, '外链不需要隐藏宿主');
});

test('about:blank 预开窗口 attach 到隐藏宿主，不 discard、不打开浏览器', () => {
  const { controller, hosts, opened } = setup();
  const popup = fakePopup();
  assert.equal(controller.handleNewWindow({ targetUrl: 'about:blank', window: popup }), true);
  assert.equal(popup.discarded, 0, 'discard 会让 dsh 退化成复制链接');
  assert.deepEqual(popup.attached, [hosts[0].webview]);
  assert.equal(hosts[0].webview.listenerCount('loadstart'), 1);
  assert.deepEqual(opened, [], 'about:blank 不能交给系统浏览器');
});

test('预开窗口导航到真实 URL：转系统浏览器并销毁隐藏宿主', () => {
  const { controller, hosts, opened } = setup();
  const popup = fakePopup();
  controller.handleNewWindow({ targetUrl: 'about:blank', window: popup });

  hosts[0].webview.emit('loadstart', { url: 'about:blank' });
  assert.deepEqual(opened, [], 'about:blank 装载事件被忽略');
  assert.equal(hosts[0].dismissCount, 0);

  const authorize = 'https://platform.deepseek.com/dsh/authorize?authorize_id=x&theme=dark';
  hosts[0].webview.emit('loadstart', { url: authorize });
  assert.deepEqual(opened, [authorize]);
  assert.equal(hosts[0].dismissCount, 1);
  assert.equal(hosts[0].webview.listenerCount('loadstart'), 0, '转发后停止跟踪');

  hosts[0].webview.emit('loadstart', { url: 'https://platform.deepseek.com/other' });
  assert.deepEqual(opened, [authorize], '迟到的装载事件不会重复转发');
});

test('attach 失败时退回 discard，不把 about:blank 交给浏览器', () => {
  const { controller, hosts, opened, logs } = setup();
  const popup = fakePopup();
  popup.attachThrows = true;
  controller.handleNewWindow({ targetUrl: 'about:blank', window: popup });
  assert.equal(popup.discarded, 1);
  assert.deepEqual(opened, []);
  assert.equal(hosts[0].dismissCount, 1, '失败的宿主被销毁');
  assert.equal(hosts[0].webview.listenerCount('loadstart'), 0);
  assert.ok(logs.some((message) => message.includes('cannot attach popup')));
});

test('宿主创建失败时退回 discard；dispose 后停止跟踪', () => {
  const { controller, opened, logs } = setup({ createHostThrows: true });
  const popup = fakePopup();
  controller.handleNewWindow({ targetUrl: 'about:blank', window: popup });
  assert.equal(popup.discarded, 1);
  assert.deepEqual(opened, []);
  assert.ok(logs.some((message) => message.includes('cannot create popup host')));
});

test('第二次预开窗口替换旧宿主，旧宿主的迟到事件被忽略', () => {
  const { controller, hosts, opened } = setup();
  const first = fakePopup();
  const second = fakePopup();
  controller.handleNewWindow({ targetUrl: 'about:blank', window: first });
  controller.handleNewWindow({ targetUrl: 'about:blank', window: second });
  assert.equal(hosts.length, 2);
  assert.equal(hosts[0].dismissCount, 1, '旧宿主被销毁');
  assert.equal(hosts[0].webview.listenerCount('loadstart'), 0);
  assert.deepEqual(second.attached, [hosts[1].webview]);

  hosts[0].webview.emit('loadstart', { url: 'https://old.example/x' });
  assert.deepEqual(opened, [], '旧宿主的导航不再转发');

  hosts[1].webview.emit('loadstart', { url: 'https://new.example/y' });
  assert.deepEqual(opened, ['https://new.example/y']);
  assert.equal(hosts[1].dismissCount, 1);
});

test('dispose 销毁当前宿主并停止转发', () => {
  const { controller, hosts, opened } = setup();
  const popup = fakePopup();
  controller.handleNewWindow({ targetUrl: 'about:blank', window: popup });
  controller.dispose();
  assert.equal(hosts[0].dismissCount, 1);
  assert.equal(hosts[0].webview.listenerCount('loadstart'), 0);
  hosts[0].webview.emit('loadstart', { url: 'https://late.example/x' });
  assert.deepEqual(opened, []);
});
