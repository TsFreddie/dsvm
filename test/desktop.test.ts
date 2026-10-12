import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, tempDir } from './helpers.js';
import {
  fetchLatestNwVersion,
  nwAssetFor,
  nwBinaryFor,
  nwInstallDir,
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
  assert.match(entry, /^Icon=\/opt\/dsvm\/desktop\/icon\.png$/m);
  assert.match(entry, /^Terminal=false$/m);
  assert.ok(!entry.includes('dsvm.js'), 'shortcuts must not go through dsvm');
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
