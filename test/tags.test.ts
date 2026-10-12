import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addFakeDsh, runCli, tempDir } from './helpers.js';

interface Config {
  current: { kind: string; spec: string; version: string } | null;
  installed: Record<string, { installedAt?: string; tag?: string | null }>;
  tags: Record<string, string>;
}

function readConfig(home: string): Config {
  return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as Config;
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

test('latest and next are independent tag pointers', async (t) => {
  const distTags: Record<string, string> = { latest: '1.0.0', next: '1.0.0' };
  const registry = await startRegistry(() => distTags, ['1.0.0', '2.0.0']);
  t.after(() => registry.close());

  const home = tempDir('tags');
  addFakeDsh(home, '1.0.0');
  addFakeDsh(home, '2.0.0');
  const env = { DSVM_REGISTRY: registry.registry };

  // Both tags initially point at the same version.
  const installLatest = await runCli(home, ['install', 'latest'], env);
  assert.equal(installLatest.code, 0, installLatest.stderr);
  let config = readConfig(home);
  assert.equal(config.tags.latest, '1.0.0');
  assert.equal(config.current?.version, '1.0.0');

  // Installing `next` records it even though the version is already on disk,
  // and does not switch the active tag away from `latest`.
  const installNext = await runCli(home, ['install', 'next'], env);
  assert.equal(installNext.code, 0, installNext.stderr);
  config = readConfig(home);
  assert.equal(config.tags.next, '1.0.0');
  assert.equal(config.tags.latest, '1.0.0');
  assert.equal(config.current?.spec, 'latest');
  assert.ok(config.installed['1.0.0']?.installedAt);

  // next moves to 2.0.0 in the registry: updating it only moves that pointer.
  distTags.next = '2.0.0';
  const updateNext = await runCli(home, ['update', 'next'], env);
  assert.equal(updateNext.code, 0, updateNext.stderr);
  config = readConfig(home);
  assert.equal(config.tags.next, '2.0.0');
  assert.equal(config.tags.latest, '1.0.0');
  assert.equal(config.current?.spec, 'latest');
  assert.equal(config.current?.version, '1.0.0');

  // Switching to next keeps both tag memories intact.
  const useNext = await runCli(home, ['use', 'next'], env);
  assert.equal(useNext.code, 0, useNext.stderr);
  config = readConfig(home);
  assert.equal(config.current?.version, '2.0.0');
  assert.equal(config.tags.latest, '1.0.0');
  assert.equal(config.tags.next, '2.0.0');

  // Bare `dsvm update` updates the tag currently in use, still leaving the
  // other tag alone.
  const updateDefault = await runCli(home, ['update'], env);
  assert.equal(updateDefault.code, 0, updateDefault.stderr);
  config = readConfig(home);
  assert.equal(config.current?.version, '2.0.0');
  assert.equal(config.tags.latest, '1.0.0');
  assert.equal(config.tags.next, '2.0.0');
});
