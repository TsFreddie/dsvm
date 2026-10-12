import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cachedTag, isExactVersion, resolveFromPackument, resolveSpec } from '../src/registry.js';
import { compareVersions } from '../src/versions.js';
import { tempDir } from './helpers.js';

test('isExactVersion accepts versions and rejects tags/ranges', () => {
  assert.equal(isExactVersion('0.2.0-rc.2'), true);
  assert.equal(isExactVersion('1.0.0+build.5'), true);
  assert.equal(isExactVersion('latest'), false);
  assert.equal(isExactVersion('^1.0.0'), false);
  assert.equal(isExactVersion('1.0'), false);
});

test('resolveFromPackument maps dist-tags', () => {
  const packument = { distTags: { latest: '0.2.0-rc.2', alpha: '0.2.1-alpha.2' } };
  assert.deepEqual(resolveFromPackument(packument, 'latest'), { version: '0.2.0-rc.2', tag: 'latest' });
  assert.equal(resolveFromPackument(packument, 'beta'), null);
});

test('cachedTag returns only non-empty mappings', () => {
  assert.equal(cachedTag({ latest: '1.0.0' }, 'latest'), '1.0.0');
  assert.equal(cachedTag({ latest: '' }, 'latest'), null);
  assert.equal(cachedTag({}, 'latest'), null);
});

test('compareVersions orders releases and prereleases', () => {
  assert.ok(compareVersions('1.0.0', '0.9.9') > 0);
  assert.ok(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10') < 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-rc.1') > 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('resolveSpec falls back to the cached packument offline', async (t) => {
  const home = tempDir('registry');
  const previousHome = process.env.DSVM_HOME;
  const previousRegistry = process.env.DSVM_REGISTRY;
  process.env.DSVM_HOME = home;
  process.env.DSVM_REGISTRY = 'http://127.0.0.1:9';
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSVM_HOME;
    else process.env.DSVM_HOME = previousHome;
    if (previousRegistry === undefined) delete process.env.DSVM_REGISTRY;
    else process.env.DSVM_REGISTRY = previousRegistry;
  });

  mkdirSync(join(home, 'cache'), { recursive: true });
  writeFileSync(
    join(home, 'cache', 'packument.json'),
    JSON.stringify({
      registry: 'http://127.0.0.1:9',
      fetchedAt: '2020-01-01T00:00:00.000Z',
      doc: { distTags: { latest: '1.2.3' }, versions: ['1.2.3'] },
    }),
  );

  const resolved = await resolveSpec('latest');
  assert.equal(resolved.version, '1.2.3');
  assert.equal(resolved.tag, 'latest');
  assert.equal(resolved.source, 'offline');
});
