import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { PROJECT_ROOT } from './helpers.js';

interface FakeItem {
  type: string;
  label: string;
  checked: boolean;
}

export interface FakeWin {
  handlers: Record<string, () => void>;
  hidden: boolean;
  shown: boolean;
  on: (event: string, fn: () => void) => void;
  show: () => void;
  hide: () => void;
  focus: () => void;
}

function installNwStub(
  collected: FakeItem[],
  clicks: Record<string, () => void>,
  wins: FakeWin[],
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
          shown: false,
          on: (event: string, fn: () => void) => {
            win.handlers[event] = fn;
          },
          show: () => {
            win.shown = true;
          },
          hide: () => {
            win.hidden = true;
          },
          focus: () => undefined,
        };
        wins.push(win);
        cb(win);
      },
    },
    App: { quit: () => undefined },
    Shell: { openExternal: () => undefined },
  };
}

test('tray checkbox clicks flip settings without native auto-toggle', () => {
  const collected: FakeItem[] = [];
  const clicks: Record<string, () => void> = {};
  installNwStub(collected, clicks, []);

  const home = mkdtempSync(join(tmpdir(), 'dsvm-tray-'));
  const previous = process.env.DSVM_HOME;
  process.env.DSVM_HOME = home;
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

    clicks['轻量后台模式']?.();
    assert.equal(readSettings().lightweightMode, true);
    assert.equal(box('轻量后台模式').checked, true);

    clicks['关闭时最小化']?.();
    assert.equal(readSettings().closeToMinimize, true);
    assert.equal(box('关闭时最小化').checked, true);
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
  }
});
