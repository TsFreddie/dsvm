import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { addFakeDsh, DSVM_BIN, runCli, setCurrent, tempDir } from './helpers.js';

const skipWindows = { skip: process.platform === 'win32' };

function makeFakeBin(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = tempDir('link-bin');
  symlinkSync(DSVM_BIN, join(dir, 'dsvm'));
  return {
    dir,
    env: { PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` },
  };
}

function dshLinkTarget(home: string, version: string): string {
  return join(home, 'versions', version, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

async function startRegistry(
  distTags: () => Record<string, string>,
  versions: string[],
): Promise<{ registry: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        'dist-tags': distTags(),
        versions: Object.fromEntries(versions.map((version) => [version, {}])),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    registry: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('dsvm link creates dsh beside dsvm and points at the active version', skipWindows, async () => {
  const home = tempDir('link');
  addFakeDsh(home, '1.2.3');
  setCurrent(home, '1.2.3');
  const { dir, env } = makeFakeBin();

  const result = await runCli(home, ['link'], env);
  assert.equal(result.code, 0, result.stderr);

  const linkPath = join(dir, 'dsh');
  assert.ok(lstatSync(linkPath).isSymbolicLink());
  assert.equal(readlinkSync(linkPath), dshLinkTarget(home, '1.2.3'));
  assert.ok(result.stdout.includes(linkPath), result.stdout);
  assert.ok(result.stdout.includes(dshLinkTarget(home, '1.2.3')), result.stdout);

  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as {
    link?: { path: string; kind: string };
  };
  assert.deepEqual(config.link, { path: linkPath, kind: 'symlink' });

  // The link is a real `dsh` command, not a wrapper around dsvm.
  const executed = spawnSync(linkPath, ['hello', 'world'], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.equal(executed.status, 0, executed.stderr);
  assert.match(executed.stdout, /fake dsh argv: hello world/);
});

test('switching versions re-points a configured link automatically', skipWindows, async () => {
  const home = tempDir('link-use');
  addFakeDsh(home, '1.0.0');
  addFakeDsh(home, '2.0.0');
  setCurrent(home, '1.0.0');
  const { dir, env } = makeFakeBin();

  assert.equal((await runCli(home, ['link'], env)).code, 0);
  const linkPath = join(dir, 'dsh');
  assert.equal(readlinkSync(linkPath), dshLinkTarget(home, '1.0.0'));

  // No PATH override here: only the recorded link path is needed.
  const use = await runCli(home, ['use', '2.0.0']);
  assert.equal(use.code, 0, use.stderr);
  assert.match(use.stdout, /updated dsh link/);
  assert.equal(readlinkSync(linkPath), dshLinkTarget(home, '2.0.0'));

  // A link the user removed is forgotten instead of being silently recreated.
  unlinkSync(linkPath);
  const again = await runCli(home, ['use', '1.0.0']);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(existsSync(linkPath), false);
  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as {
    link?: unknown;
  };
  assert.equal(config.link, undefined);
});

test('updating the active tag re-points a configured link automatically', skipWindows, async (t) => {
  const distTags: Record<string, string> = { latest: '1.0.0' };
  const registry = await startRegistry(() => distTags, ['1.0.0', '2.0.0']);
  t.after(() => registry.close());

  const home = tempDir('link-update');
  addFakeDsh(home, '1.0.0');
  addFakeDsh(home, '2.0.0');
  const { dir, env } = makeFakeBin();
  const registryEnv = { ...env, DSVM_REGISTRY: registry.registry };

  const install = await runCli(home, ['install', 'latest'], registryEnv);
  assert.equal(install.code, 0, install.stderr);
  assert.equal((await runCli(home, ['link'], registryEnv)).code, 0);
  const linkPath = join(dir, 'dsh');
  assert.equal(readlinkSync(linkPath), dshLinkTarget(home, '1.0.0'));

  distTags.latest = '2.0.0';
  const update = await runCli(home, ['update'], registryEnv);
  assert.equal(update.code, 0, update.stderr);
  assert.match(update.stdout, /updated dsh link/);
  assert.equal(readlinkSync(linkPath), dshLinkTarget(home, '2.0.0'));
});

test('dsvm link refuses an unrelated dsh file unless --force is used', skipWindows, async () => {
  const home = tempDir('link-force');
  addFakeDsh(home, '1.2.3');
  setCurrent(home, '1.2.3');
  const { dir, env } = makeFakeBin();
  const linkPath = join(dir, 'dsh');
  writeFileSync(linkPath, '#!/bin/sh\necho other dsh\n', { mode: 0o755 });

  const refused = await runCli(home, ['link'], env);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /refusing to replace/);
  assert.match(refused.stderr, /--force/);
  assert.equal(readFileSync(linkPath, 'utf8'), '#!/bin/sh\necho other dsh\n');

  const forced = await runCli(home, ['link', '--force'], env);
  assert.equal(forced.code, 0, forced.stderr);
  assert.ok(lstatSync(linkPath).isSymbolicLink());
  assert.equal(readlinkSync(linkPath), dshLinkTarget(home, '1.2.3'));
});

test('dsvm link fails cleanly without an active version', async () => {
  const home = tempDir('link-none');
  const result = await runCli(home, ['link']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /no active dsh version/);
});

test('dsvm help documents link', async () => {
  const home = tempDir('link-help');
  const general = await runCli(home, ['help']);
  assert.equal(general.code, 0);
  assert.match(general.stdout, /dsvm link/);

  const topic = await runCli(home, ['help', 'link']);
  assert.equal(topic.code, 0, topic.stderr);
  assert.match(topic.stdout, /Usage: dsvm link/);
  assert.match(topic.stdout, /--force/);
});
