import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeCurrent,
  readConfig,
  updateConfig,
  withLock,
  writeConfig,
} from '../src/config.js';
import { sleep } from '../src/util.js';
import { tempDir } from './helpers.js';

function useHome(t: { after: (fn: () => void) => void }): string {
  const home = tempDir('config');
  const previous = process.env.DSVM_HOME;
  process.env.DSVM_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.DSVM_HOME;
    else process.env.DSVM_HOME = previous;
  });
  return home;
}

test('readConfig returns defaults when no config exists', (t) => {
  useHome(t);
  const config = readConfig();
  assert.deepEqual(config, { schema: 1, current: null, installed: {}, tags: {} });
});

test('config round-trips and normalizes the current selection', (t) => {
  const home = useHome(t);
  writeConfig({
    schema: 1,
    current: { kind: 'tag', spec: 'alpha', version: '1.2.3-alpha.1' },
    installed: { '1.2.3-alpha.1': { installedAt: '2025-01-01T00:00:00.000Z', tag: 'alpha' } },
    tags: { alpha: '1.2.3-alpha.1' },
  });
  const config = readConfig();
  assert.equal(config.current?.kind, 'tag');
  assert.equal(config.current?.spec, 'alpha');
  assert.equal(config.tags.alpha, '1.2.3-alpha.1');
  assert.ok(home.endsWith('config') === false);
  assert.equal(describeCurrent(config), '1.2.3-alpha.1 (alpha)');
});

test('updateConfig mutates in place', (t) => {
  useHome(t);
  updateConfig((config) => {
    config.tags.latest = '1.0.0';
  });
  assert.equal(readConfig().tags.latest, '1.0.0');
});

test('withLock serializes concurrent mutations', async (t) => {
  useHome(t);
  let active = 0;
  let maxActive = 0;
  const task = () =>
    withLock(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(40);
      active -= 1;
    });
  await Promise.all([task(), task(), task()]);
  assert.equal(maxActive, 1);
});
