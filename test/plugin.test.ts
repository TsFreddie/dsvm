import test from 'node:test';
import assert from 'node:assert/strict';
import { withDefaultProfile } from '../src/plugin.js';
import { addFakeDsh, runCli, setCurrent, tempDir } from './helpers.js';

test('dsvm plugin hands `plugin` plus all arguments to dsh', async () => {
  const home = tempDir('plugin-handoff');
  addFakeDsh(home);
  setCurrent(home);
  const result = await runCli(home, ['plugin', '--profile', 'tui', 'add', 'some-pkg']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /fake dsh argv: plugin --profile tui add some-pkg/);
});

test('dsvm plugin defaults to --profile web when no profile is given', async () => {
  const home = tempDir('plugin-default-profile');
  addFakeDsh(home);
  setCurrent(home);
  const result = await runCli(home, ['plugin', 'add', 'some-pkg']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /fake dsh argv: plugin --profile web add some-pkg/);
});

test('dsvm plugin passes --help through to dsh', async () => {
  const home = tempDir('plugin-help-passthrough');
  addFakeDsh(home);
  setCurrent(home);
  const result = await runCli(home, ['plugin', '--help']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /fake dsh argv: plugin --profile web --help/);
});

test('withDefaultProfile respects explicit profiles', () => {
  assert.deepEqual(withDefaultProfile(['add', 'x']), ['--profile', 'web', 'add', 'x']);
  assert.deepEqual(withDefaultProfile([]), ['--profile', 'web']);
  assert.deepEqual(withDefaultProfile(['--profile', 'tui', 'add', 'x']), ['--profile', 'tui', 'add', 'x']);
  assert.deepEqual(withDefaultProfile(['--profile=tui', 'add', 'x']), ['--profile=tui', 'add', 'x']);
  // `--profile` after `--` is a pnpm operand, not dsh's option.
  assert.deepEqual(withDefaultProfile(['--', '--profile', 'x']), ['--profile', 'web', '--', '--profile', 'x']);
});

test('plugin fails cleanly without an active version', async () => {
  const home = tempDir('plugin-none');
  const result = await runCli(home, ['plugin', '--profile', 'tui', 'add', 'some-pkg']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /no active dsh version/);
});

test('dsvm help documents the plugin passthrough', async () => {
  const home = tempDir('plugin-help');
  const general = await runCli(home, ['help']);
  assert.equal(general.code, 0);
  assert.match(general.stdout, /dsvm plugin/);

  const topic = await runCli(home, ['help', 'plugin']);
  assert.equal(topic.code, 0);
  assert.match(topic.stdout, /Usage: dsvm plugin/);
  assert.match(topic.stdout, /dsh plugin/);
  assert.match(topic.stdout, /--profile web/);
});
