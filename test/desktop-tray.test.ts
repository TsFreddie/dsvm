import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { PROJECT_ROOT } from './helpers.js';

interface FakeItem {
  type: string;
  label: string;
  checked: boolean;
}

type AppHandlers = Record<string, Array<(arg?: unknown) => void>>;

export interface FakeWin {
  handlers: Record<string, () => void>;
  hidden: boolean;
  shown: number;
  restored: number;
  focused: number;
  closeForced: boolean;
  on: (event: string, fn: () => void) => void;
  show: () => void;
  hide: () => void;
  restore: () => void;
  focus: () => void;
  close: (force?: boolean) => void;
}

function installNwStub(
  collected: FakeItem[],
  clicks: Record<string, () => void>,
  wins: FakeWin[],
  appHandlers: AppHandlers = {},
): void {
  class FakeMenuItem {
    type: string;
    label: string;
    checked: boolean;
    constructor(opts: { type: string; label: string; checked?: boolean }) {
      this.type = opts.type;
      this.label = opts.label;
      this.checked = opts.checked === true;
    }
    on(event: string, fn: () => void): void {
      if (event === 'click') {
        clicks[this.label] = fn;
        collected.push(this);
      }
    }
  }
  class FakeMenu {
    append(item: FakeMenuItem): void {
      void item;
    }
  }
  class FakeTray {
    menu: unknown = null;
    constructor(public opts: unknown) {
      void opts;
    }
    on(): void {
      // No-op.
    }
  }
  (globalThis as Record<string, unknown>).nw = {
    Tray: FakeTray,
    Menu: FakeMenu,
    MenuItem: FakeMenuItem,
    Window: {
      open: (_url: string, _opts: unknown, cb: (win: FakeWin) => void) => {
        const win: FakeWin = {
          handlers: {},
          hidden: false,
          shown: 0,
          restored: 0,
          focused: 0,
          closeForced: false,
          on: (event: string, fn: () => void) => {
            win.handlers[event] = fn;
          },
          show: () => {
            win.shown += 1;
            win.hidden = false;
          },
          hide: () => {
            win.hidden = true;
          },
          restore: () => {
            win.restored += 1;
          },
          focus: () => {
            win.focused += 1;
          },
          close: (force?: boolean) => {
            win.closeForced = force === true;
          },
        };
        wins.push(win);
        cb(win);
      },
    },
    App: {
      quit: () => undefined,
      on: (event: string, fn: (arg?: unknown) => void) => {
        (appHandlers[event] ??= []).push(fn);
      },
      onOpen: {
        addListener: (fn: (arg?: unknown) => void) => {
          (appHandlers.open ??= []).push(fn);
        },
      },
    },
    Shell: { openExternal: () => undefined },
  };
}

/** 在指定环境变量下全新加载 main.js（绕 require 缓存），返回托盘项与点击入口。 */
function loadMainWithEnv(env: Record<string, string | undefined>): {
  collected: FakeItem[];
  clicks: Record<string, () => void>;
  wins: FakeWin[];
} {
  const collected: FakeItem[] = [];
  const clicks: Record<string, () => void> = {};
  const wins: FakeWin[] = [];
  installNwStub(collected, clicks, wins);
  const req = createRequire(import.meta.url);
  const mainPath = join(PROJECT_ROOT, 'desktop', 'main.js');
  delete req.cache[mainPath];
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    req(mainPath);
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key] as string;
    }
  }
  return { collected, clicks, wins };
}

test('tray checkbox clicks flip settings without native auto-toggle', () => {
  const collected: FakeItem[] = [];
  const clicks: Record<string, () => void> = {};
  installNwStub(collected, clicks, []);
  const home = mkdtempSync(join(tmpdir(), 'dsvm-tray-'));
  const previous = process.env.DSVM_HOME;
  process.env.DSVM_HOME = home;
  // 固定 x11 环境：Wayland 下那两项本就不存在。
  const prevSession = process.env.XDG_SESSION_TYPE;
  const prevWayland = process.env.WAYLAND_DISPLAY;
  process.env.XDG_SESSION_TYPE = 'x11';
  delete process.env.WAYLAND_DISPLAY;
  try {
    const req = createRequire(import.meta.url);
    const mainPath = join(PROJECT_ROOT, 'desktop', 'main.js');
    delete req.cache[mainPath];
    req(mainPath);
    const settingsFile = join(home, 'desktop', 'settings.json');
    const readSettings = (): Record<string, boolean> =>
      JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, boolean>;
    const box = (label: string): FakeItem => {
      const found = collected.find((item) => item.label === label);
      assert.ok(found, `tray item "${label}" exists`);
      return found as FakeItem;
    };

    // 最小化到托盘：点两次，来回翻转（checkbox 本身不自动翻，由处理函数显式回写）。
    clicks['最小化到托盘']?.();
    assert.equal(readSettings().minimizeToTray, true);
    assert.equal(box('最小化到托盘').checked, true);
    clicks['最小化到托盘']?.();
    assert.equal(readSettings().minimizeToTray, false);
    assert.equal(box('最小化到托盘').checked, false);

    clicks['后台轻量模式']?.();
    assert.equal(readSettings().lightweightMode, true);
    assert.equal(box('后台轻量模式').checked, true);

    clicks['关闭到托盘']?.();
    assert.equal(readSettings().closeToTray, true);
    assert.equal(box('关闭到托盘').checked, true);
  } finally {
    if (previous === undefined) delete process.env.DSVM_HOME;
    else process.env.DSVM_HOME = previous;
    if (prevSession === undefined) delete process.env.XDG_SESSION_TYPE;
    else process.env.XDG_SESSION_TYPE = prevSession;
    if (prevWayland !== undefined) process.env.WAYLAND_DISPLAY = prevWayland;
  }
});

test('tray hides only minimize-to-tray on Wayland, keeping close-to-tray and lightweight', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsvm-tray-wayland-'));
  const previous = process.env.DSVM_HOME;
  process.env.DSVM_HOME = home;
  try {
    const { collected } = loadMainWithEnv({
      XDG_SESSION_TYPE: 'wayland',
      WAYLAND_DISPLAY: 'wayland-0',
      NW_PRE_ARGS: undefined,
    });
    const labels = collected.map((item) => item.label);
    assert.deepEqual(
      labels,
      ['关闭到托盘', '后台轻量模式', '退出'],
      'Wayland keeps close-to-tray and lightweight (tray is still reachable)',
    );
  } finally {
    if (previous === undefined) delete process.env.DSVM_HOME;
    else process.env.DSVM_HOME = previous;
  }
});

test('tray keeps all three items under explicit x11 in order', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsvm-tray-x11-'));
  const previous = process.env.DSVM_HOME;
  process.env.DSVM_HOME = home;
  try {
    const { collected } = loadMainWithEnv({
      XDG_SESSION_TYPE: 'wayland',
      WAYLAND_DISPLAY: 'wayland-0',
      NW_PRE_ARGS: '--ozone-platform=x11',
    });
    const labels = collected.map((item) => item.label);
    assert.deepEqual(
      labels,
      ['最小化到托盘', '关闭到托盘', '后台轻量模式', '退出'],
      'explicit x11 keeps every switch',
    );
  } finally {
    if (previous === undefined) delete process.env.DSVM_HOME;
    else process.env.DSVM_HOME = previous;
  }
});

test('minimize event hides the window and publishes state when enabled', () => {
  const collected: FakeItem[] = [];
  const clicks: Record<string, () => void> = {};
  const wins: FakeWin[] = [];
  installNwStub(collected, clicks, wins);

  const home = mkdtempSync(join(tmpdir(), 'dsvm-tray-win-'));
  const previous = process.env.DSVM_HOME;
  process.env.DSVM_HOME = home;
  // 固定 x11 环境：Wayland 下最小化相关托盘项本就不存在。
  const prevSession = process.env.XDG_SESSION_TYPE;
  const prevWayland = process.env.WAYLAND_DISPLAY;
  process.env.XDG_SESSION_TYPE = 'x11';
  delete process.env.WAYLAND_DISPLAY;
  try {
    const req = createRequire(import.meta.url);
    const mainPath = join(PROJECT_ROOT, 'desktop', 'main.js');
    delete req.cache[mainPath];
    req(mainPath);
    assert.equal(wins.length, 1);
    const win = wins[0] as FakeWin;
    const runtimeState = (): boolean =>
      (
        JSON.parse(
          readFileSync(join(home, 'desktop', 'runtime-state.json'), 'utf8'),
        ) as { minimized: boolean }
      ).minimized;

    // 默认关闭：minimize 只发布状态，不隐藏。
    win.handlers['minimize']?.();
    assert.equal(runtimeState(), true);
    assert.equal(win.hidden, false);
    win.handlers['restore']?.();
    assert.equal(runtimeState(), false);

    // 打开开关后：minimize 直接隐藏窗口。
    clicks['最小化到托盘']?.();
    win.handlers['minimize']?.();
    assert.equal(win.hidden, true);
    assert.equal(runtimeState(), true);
  } finally {
    if (previous === undefined) delete process.env.DSVM_HOME;
    else process.env.DSVM_HOME = previous;
    if (prevSession === undefined) delete process.env.XDG_SESSION_TYPE;
    else process.env.XDG_SESSION_TYPE = prevSession;
    if (prevWayland !== undefined) process.env.WAYLAND_DISPLAY = prevWayland;
  }
});

test('relaunch brings the main window back from minimize and from the tray', () => {
  const collected: FakeItem[] = [];
  const clicks: Record<string, () => void> = {};
  const wins: FakeWin[] = [];
  const appHandlers: AppHandlers = {};
  installNwStub(collected, clicks, wins, appHandlers);

  const home = mkdtempSync(join(tmpdir(), 'dsvm-tray-relaunch-'));
  const previous = process.env.DSVM_HOME;
  process.env.DSVM_HOME = home;
  const prevSession = process.env.XDG_SESSION_TYPE;
  const prevWayland = process.env.WAYLAND_DISPLAY;
  process.env.XDG_SESSION_TYPE = 'x11';
  delete process.env.WAYLAND_DISPLAY;
  try {
    const req = createRequire(import.meta.url);
    const mainPath = join(PROJECT_ROOT, 'desktop', 'main.js');
    delete req.cache[mainPath];
    req(mainPath);
    assert.equal(wins.length, 1);
    const win = wins[0] as FakeWin;
    const runtimeState = (): boolean =>
      (
        JSON.parse(
          readFileSync(join(home, 'desktop', 'runtime-state.json'), 'utf8'),
        ) as { minimized: boolean }
      ).minimized;

    // App.on 与兼容旧版 NW 的 onOpen 入口都要登记，reopen 供 macOS Dock 使用。
    assert.equal(appHandlers.open?.length, 2, 'open listeners registered (on + onOpen)');
    assert.equal(appHandlers.reopen?.length, 1, 'reopen listener registered');
    const relaunch = (): void => {
      for (const fn of appHandlers.open ?? []) fn();
    };

    // OS 最小化：第二次启动先 restore，再 show/focus，并清掉发布出去的状态。
    win.handlers['minimize']?.();
    assert.equal(runtimeState(), true);
    relaunch();
    assert.equal(win.restored, 1, 'restore runs once even with two open listeners');
    assert.ok(win.shown >= 1, 'window is shown');
    assert.ok(win.focused >= 1, 'window is focused');
    assert.equal(runtimeState(), false);

    // 关闭到托盘（没有 OS 最小化）：只 show/focus，不调用 restore，
    // 否则会把最大化窗口还原成普通大小。
    clicks['关闭到托盘']?.();
    win.handlers['close']?.call(win);
    assert.equal(win.hidden, true);
    win.restored = 0;
    win.shown = 0;
    win.focused = 0;
    relaunch();
    assert.equal(win.restored, 0, 'restore is skipped when the window is only hidden');
    assert.ok(win.shown >= 1, 'tray-hidden window is shown');
    assert.ok(win.focused >= 1, 'tray-hidden window is focused');
    assert.equal(win.hidden, false);
    assert.equal(wins.length, 1, 'relaunch reuses the existing window');
  } finally {
    if (previous === undefined) delete process.env.DSVM_HOME;
    else process.env.DSVM_HOME = previous;
    if (prevSession === undefined) delete process.env.XDG_SESSION_TYPE;
    else process.env.XDG_SESSION_TYPE = prevSession;
    if (prevWayland !== undefined) process.env.WAYLAND_DISPLAY = prevWayland;
  }
});

test('close-to-tray hides on Wayland and force-closes when off', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsvm-tray-close-'));
  const previous = process.env.DSVM_HOME;
  process.env.DSVM_HOME = home;
  try {
    const { collected, clicks, wins } = loadMainWithEnv({
      XDG_SESSION_TYPE: 'wayland',
      WAYLAND_DISPLAY: 'wayland-0',
      NW_PRE_ARGS: undefined,
    });
    assert.equal(wins.length, 1);
    const win = wins[0] as FakeWin;
    const runtimeState = (): boolean =>
      (
        JSON.parse(
          readFileSync(join(home, 'desktop', 'runtime-state.json'), 'utf8'),
        ) as { minimized: boolean }
      ).minimized;

    // 默认关闭：close 直接放行（force close）
    win.handlers['close']?.call(win);
    assert.equal(win.closeForced, true);
    assert.equal(win.hidden, false);

    // Wayland 下“关闭到托盘”入口存在，打开后 close 改为隐藏而不是退出。
    assert.ok(collected.some((item) => item.label === '关闭到托盘'), 'Wayland offers close-to-tray');
    clicks['关闭到托盘']?.();
    win.closeForced = false;
    win.handlers['close']?.call(win);
    assert.equal(win.hidden, true, 'close hides the window');
    assert.equal(win.closeForced, false, 'close is cancelled');
    assert.equal(runtimeState(), true, 'hidden state feeds lightweight mode');
  } finally {
    if (previous === undefined) delete process.env.DSVM_HOME;
    else process.env.DSVM_HOME = previous;
  }
});

test('legacy closeToMinimize setting migrates to closeToTray', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsvm-tray-migrate-'));
  const previous = process.env.DSVM_HOME;
  process.env.DSVM_HOME = home;
  mkdirSync(join(home, 'desktop'), { recursive: true });
  writeFileSync(join(home, 'desktop', 'settings.json'), `${JSON.stringify({ closeToMinimize: true })}\n`);
  try {
    const { collected, clicks } = loadMainWithEnv({
      XDG_SESSION_TYPE: 'x11',
      WAYLAND_DISPLAY: undefined,
      NW_PRE_ARGS: undefined,
    });
    const closeItem = collected.find((item) => item.label === '关闭到托盘');
    assert.ok(closeItem, 'close-to-tray item exists');
    assert.equal(closeItem.checked, true, 'old checked state carries over');

    // 点击后落盘的是新键。
    clicks['关闭到托盘']?.();
    const saved = JSON.parse(readFileSync(join(home, 'desktop', 'settings.json'), 'utf8')) as {
      closeToTray?: boolean;
    };
    assert.equal(saved.closeToTray, false);
  } finally {
    if (previous === undefined) delete process.env.DSVM_HOME;
    else process.env.DSVM_HOME = previous;
  }
});

test('detectWayland prefers the resolved ozone switch', () => {
  installNwStub([], {}, []);
  const req = createRequire(import.meta.url);
  const mainPath = join(PROJECT_ROOT, 'desktop', 'main.js');
  delete req.cache[mainPath];
  const { detectWayland } = req(mainPath) as {
    detectWayland: (input: {
      sessionType?: string;
      waylandDisplay?: string;
      nwPreArgs?: string;
      ozonePlatform?: string | null;
    }) => boolean;
  };
  const base = { sessionType: 'wayland', waylandDisplay: 'wayland-0', nwPreArgs: '', ozonePlatform: null };
  assert.equal(detectWayland(base), true);
  // 解析出的 ozone 开关压倒一切。
  assert.equal(detectWayland({ ...base, ozonePlatform: 'x11' }), false);
  assert.equal(
    detectWayland({ sessionType: undefined, waylandDisplay: undefined, nwPreArgs: '', ozonePlatform: 'wayland' }),
    true,
  );
  // 显式 x11 压倒 wayland 会话；显式 wayland 压倒 x11 会话。
  assert.equal(detectWayland({ ...base, nwPreArgs: '--ozone-platform=x11' }), false);
  assert.equal(
    detectWayland({ sessionType: 'x11', waylandDisplay: undefined, nwPreArgs: '--ozone-platform=wayland', ozonePlatform: null }),
    true,
  );
  // 纯 x11 会话。
  assert.equal(
    detectWayland({ sessionType: 'x11', waylandDisplay: 'wayland-0', nwPreArgs: '', ozonePlatform: null }),
    false,
  );
  // 裸 X（无 Wayland 痕迹）。
  assert.equal(
    detectWayland({ sessionType: undefined, waylandDisplay: undefined, nwPreArgs: '', ozonePlatform: null }),
    false,
  );
});
