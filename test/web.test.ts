import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addFakeDsh, runCli, setCurrent, spawnCli, tempDir, waitFor } from './helpers.js';

test('dsvm web hands `web` plus all arguments to dsh', async () => {
  const home = tempDir('web-handoff');
  addFakeDsh(home);
  setCurrent(home);
  const result = await runCli(home, ['web', '--port', '7788', '--no-open']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /fake dsh argv: web --port 7788 --no-open/);
});

test('service mode records the dsh URL and clears it on exit', async () => {
  const home = tempDir('web-service');
  addFakeDsh(home);
  setCurrent(home);
  const child = spawnCli(home, ['web', '--port', '7766', '--no-open'], {
    DSVM_SERVICE: '1',
    FAKE_DSH_HOLD: '1',
    FAKE_DSH_URL: 'http://127.0.0.1:7766/?token=secret-token',
  });
  const urlFile = join(home, 'service', 'url.json');
  await waitFor(() => existsSync(urlFile), { what: 'service URL state' });
  const state = JSON.parse(readFileSync(urlFile, 'utf8')) as {
    url: string;
    pid: number;
    dsvmPid: number;
    port: number;
  };
  assert.equal(state.url, 'http://127.0.0.1:7766/?token=secret-token');
  assert.equal(state.port, 7766);
  assert.ok(state.pid > 0);
  assert.ok(state.dsvmPid > 0);

  process.kill(state.pid, 'SIGTERM');
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (exitCode) => resolve(exitCode));
  });
  assert.equal(code, 0);
  assert.equal(existsSync(urlFile), false);
});

test('web fails cleanly without an active version', async () => {
  const home = tempDir('web-none');
  const result = await runCli(home, ['web']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /no active dsh version/);
});
