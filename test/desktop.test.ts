import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT, runCli, tempDir } from './helpers.js';
import {
  DownloadProgress,
  fetchLatestNwVersion,
  formatBytes,
  nwAssetFor,
  nwBinaryFor,
  nwInstallDir,
  renderProgressBar,
} from '../src/desktop/nwjs.js';
import {
  installShortcut,
  linuxDesktopEntry,
  linuxDesktopFile,
} from '../src/desktop/shortcut.js';

test('nwAssetFor maps platforms to SDK artifacts', () => {
  const linux = nwAssetFor('linux', 'x64');
  assert.equal(linux.asset, 'linux-x64');
  assert.equal(linux.ext, 'tar.gz');
  assert.equal(linux.file('v0.118.0'), 'nwjs-sdk-v0.118.0-linux-x64.tar.gz');
  assert.match(nwBinaryFor('v0.118.0', linux), /nwjs-sdk-v0\.118\.0-linux-x64[\\/]nw$/);

  const win = nwAssetFor('win32', 'x64');
  assert.equal(win.asset, 'win-x64');
  assert.equal(win.ext, 'zip');
  assert.equal(win.file('v0.118.0'), 'nwjs-sdk-v0.118.0-win-x64.zip');
  assert.match(nwBinaryFor('v0.118.0', win), /nw\.exe$/);

  const mac = nwAssetFor('darwin', 'arm64');
  assert.equal(mac.asset, 'osx-arm64');
  assert.equal(mac.ext, 'zip');
  assert.match(nwBinaryFor('v0.118.0', mac), /nwjs\.app[\\/]Contents[\\/]MacOS[\\/]nwjs$/);

  assert.throws(() => nwAssetFor('sunos' as NodeJS.Platform, 'x64'), /does not support platform/);
  assert.ok(nwInstallDir('v0.118.0').endsWith(join('desktop', 'nwjs', 'v0.118.0')));
});

test('fetchLatestNwVersion prefers stable and validates shape', async () => {
  const fake = (payload: unknown) =>
    (async () => ({ ok: true, json: async () => payload }) as Response) as typeof fetch;
  assert.equal(
    await fetchLatestNwVersion(fake({ stable: 'v0.118.0', latest: 'v0.117.0' })),
    'v0.118.0',
  );
  assert.equal(await fetchLatestNwVersion(fake({ latest: 'v0.117.0' })), 'v0.117.0');
  await assert.rejects(fetchLatestNwVersion(fake({})), /cannot parse/);
  await assert.rejects(
    fetchLatestNwVersion(async () => {
      throw new Error('boom');
    }),
    /cannot reach/,
  );
});

test('linuxDesktopEntry launches nw directly with the app dir', () => {
  const entry = linuxDesktopEntry('/home/u/.dsvm/desktop/nwjs/v0.118.0/nw', '/opt/dsvm/desktop', '/opt/dsvm/desktop/icon.png');
  assert.match(entry, /^\[Desktop Entry\]$/m);
  assert.match(entry, /^Exec=.*nw.*desktop %U$/m);
  assert.match(entry, /^Name=DeepSeek Harness \(dsvm\)$/m);
  assert.match(entry, /^Icon=\/opt\/dsvm\/desktop\/icon\.png$/m);
  assert.match(entry, /^Terminal=false$/m);
  assert.ok(!entry.includes('dsvm.js'), 'shortcuts must not go through dsvm');
});

test('progress helpers format bytes and bars', () => {
  assert.equal(formatBytes(0), '0.0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(221185670), '211 MB');
  assert.equal(renderProgressBar(0, 100), `[${'-'.repeat(24)}]`);
  assert.equal(renderProgressBar(100, 100), `[${'='.repeat(24)}]`);
  assert.equal(renderProgressBar(50, 100), `[${'='.repeat(12)}${'-'.repeat(12)}]`);
  assert.equal(renderProgressBar(5, null), `[${'.'.repeat(24)}]`);
});

test('DownloadProgress logs steps without a TTY and refreshes with one', () => {
  const lines: string[] = [];
  let clock = 0;
  const plain = new DownloadProgress('downloading x', 100, { write: (s) => lines.push(s), isTTY: false }, () => clock);
  clock = 1000;
  plain.update(5);
  plain.update(10);
  clock = 2000;
  plain.finish();
  assert.ok(lines.some((line) => line.includes('10%')), lines.join(''));
  assert.ok(lines.at(-1)?.includes('done'), lines.join(''));

  const frames: string[] = [];
  const tty = new DownloadProgress('downloading x', 100, { write: (s) => frames.push(s), isTTY: true }, () => clock);
  clock = 3000;
  tty.update(50);
  clock = 4000;
  tty.finish();
  assert.ok(frames[0]?.startsWith('\r'), frames.join(''));
  assert.ok(frames[0]?.includes('50%'), frames.join(''));
  assert.ok(frames.at(-1)?.endsWith('\n'), frames.join(''));
});

test('bundled desktop app uses webview with sane defaults', () => {
  const root = join(PROJECT_ROOT, 'desktop');
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  assert.ok(html.includes('<webview'), 'embeds dsh with <webview>');
  assert.ok(!html.includes('<iframe'), 'does not use <iframe>');
  assert.match(html, /partition="persist:dsvm-desktop"/);
  assert.match(html, /HIDE_UNLOAD_MS = 5_000/);
  assert.ok(html.includes('loadabort'), 'handles webview load failures');
  assert.ok(html.includes('newwindow'), 'routes popups to the system browser');
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    main?: string;
    window?: { title?: string };
    ['chromium-args']?: string;
  };
  assert.equal(manifest.main, 'main.js');
  assert.equal(manifest.window?.title, 'DeepSeek Harness (dsvm)');
  assert.match(manifest['chromium-args'] ?? '', /--ozone-platform-hint=auto/);
  assert.match(manifest['chromium-args'] ?? '', /--enable-wayland-ime/);
  assert.match(manifest['chromium-args'] ?? '', /--wayland-text-input-version=3/);
});

test('lightweight mode follows minimize state via runtime-state.json', () => {
  const root = join(PROJECT_ROOT, 'desktop');
  const main = readFileSync(join(root, 'main.js'), 'utf8');
  assert.ok(main.includes("win.on('minimize'"), 'tracks OS minimize');
  assert.ok(main.includes("win.on('restore'"), 'tracks restore');
  assert.ok(main.includes('runtime-state.json'), 'publishes minimize state for the page');
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  assert.ok(html.includes('readMinimized'), 'page polls minimize state');
  assert.ok(html.includes('minimizedSince'), 'unload timing is minimize-based');
  assert.ok(html.includes('.terminate('), 'unload kills the guest renderer');
  assert.ok(html.includes('open-external.js'), 'external links go through the shared opener');
});

test('desktop help and unknown subcommands', async () => {
  const home = tempDir('desktop');
  const help = await runCli(home, ['desktop', 'help']);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /NW\.js/);
  assert.match(help.stdout, /uninstall/);

  const topic = await runCli(home, ['help', 'desktop']);
  assert.equal(topic.code, 0, topic.stderr);
  assert.match(topic.stdout, /dsvm desktop/);

  const bad = await runCli(home, ['desktop', 'frobnicate']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /unknown desktop subcommand/);

  const extra = await runCli(home, ['desktop', 'install', 'extra']);
  assert.notEqual(extra.code, 0);
  assert.match(extra.stderr, /usage: dsvm desktop/);
});

test('desktop uninstall without a shortcut still clears the cache', async () => {
  const home = tempDir('desktop');
  const xdg = tempDir('desktop-xdg');
  const result = await runCli(home, ['desktop', 'uninstall'], { XDG_DATA_HOME: xdg });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /no dsvm desktop shortcut found/);
  assert.match(result.stdout, /deleted the cached nw\.js SDK/);
});

test('installShortcut writes a linux .desktop entry under XDG_DATA_HOME', { skip: process.platform !== 'linux' }, async () => {
  const xdg = tempDir('desktop-xdg');
  process.env.XDG_DATA_HOME = xdg;
  try {
    const result = await installShortcut('/fake/nw', '/fake/app');
    assert.equal(result.created.length, 1);
    assert.equal(result.created[0], linuxDesktopFile());
    assert.ok(existsSync(result.created[0]));
    const content = readFileSync(result.created[0], 'utf8');
    assert.match(content, /Exec=\/fake\/nw \/fake\/app %U/);
  } finally {
    delete process.env.XDG_DATA_HOME;
  }
});
