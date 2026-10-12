import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { addFakeDsh, runCli, setCurrent, tempDir, writeConfig } from './helpers.js';

test('dsvm version and help work', async () => {
  const home = tempDir('cli');
  const version = await runCli(home, ['version']);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /^dsvm \d+\.\d+\.\d+/);

  const help = await runCli(home, ['help', 'service']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /dsvm service <subcommand>/);
  assert.match(help.stdout, /systemd user unit/);
});

test('unknown commands fail with usage', async () => {
  const home = tempDir('cli');
  const result = await runCli(home, ['frobnicate']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /unknown command "frobnicate"/);
});

test('list and current reflect the active version', async () => {
  const home = tempDir('cli');
  addFakeDsh(home, '9.9.9');
  setCurrent(home, '9.9.9');
  const list = await runCli(home, ['list']);
  assert.equal(list.code, 0);
  assert.match(list.stdout, /^\* 9\.9\.9/m);
  assert.match(list.stdout, /current: 9\.9\.9 \(pinned\)/);

  const current = await runCli(home, ['current']);
  assert.equal(current.stdout.trim(), '9.9.9 (pinned)');
});

test('list shows reverse dist-tags and install times', async () => {
  const home = tempDir('cli');
  addFakeDsh(home, '9.9.9');
  writeConfig(home, {
    schema: 1,
    current: { kind: 'tag', spec: 'alpha', version: '9.9.9' },
    installed: { '9.9.9': { installedAt: '2026-10-12T05:35:00.000Z', tag: 'alpha' } },
    tags: { alpha: '9.9.9', latest: '9.9.9' },
  });
  const list = await runCli(home, ['list']);
  assert.equal(list.code, 0);
  assert.match(list.stdout, /\* 9\.9\.9 +alpha, latest +installed 2026-10-12 05:35/);

  const json = await runCli(home, ['list', '--json']);
  const parsed = JSON.parse(json.stdout) as {
    installed: string[];
    info: Record<string, { installedAt: string | null; tags: string[] }>;
  };
  assert.deepEqual(parsed.installed, ['9.9.9']);
  assert.deepEqual(parsed.info['9.9.9']?.tags.sort(), ['alpha', 'latest']);
  assert.equal(parsed.info['9.9.9']?.installedAt, '2026-10-12T05:35:00.000Z');
});

test('update without a tag refuses pinned versions', async () => {
  const home = tempDir('cli');
  setCurrent(home, '9.9.9');
  const result = await runCli(home, ['update']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /pinned/);
  assert.match(result.stderr, /dsvm update latest/);
});

test('update without a tag reports no active version', async () => {
  const home = tempDir('cli');
  writeConfig(home, { schema: 1, current: null, installed: {}, tags: {} });
  const result = await runCli(home, ['update']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /no active dsh version/);
});

test('uninstall removes inactive versions and refuses the active one', async () => {
  const home = tempDir('cli');
  addFakeDsh(home, '1.0.0');
  addFakeDsh(home, '2.0.0');
  setCurrent(home, '2.0.0');

  const removeOther = await runCli(home, ['uninstall', '1.0.0']);
  assert.equal(removeOther.code, 0, removeOther.stderr);
  assert.equal(existsSync(join(home, 'versions', '1.0.0')), false);
  assert.equal(existsSync(join(home, 'versions', '2.0.0')), true);

  const removeActive = await runCli(home, ['uninstall', '2.0.0']);
  assert.notEqual(removeActive.code, 0);
  assert.match(removeActive.stderr, /active version/);
});
