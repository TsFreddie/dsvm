import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, tempDir, waitFor, writeScript } from './helpers.js';

const skipNonLinux = { skip: process.platform !== 'linux' };
const URL = 'http://127.0.0.1:7766/?token=open-me';

function setup(pid: number) {
  const home = tempDir('open');
  const xdg = tempDir('open-xdg');
  const fakebin = tempDir('open-bin');
  mkdirSync(join(xdg, 'systemd', 'user'), { recursive: true });
  writeFileSync(join(xdg, 'systemd', 'user', 'dsvm.service'), '[Unit]\nDescription=fake\n');
  mkdirSync(join(home, 'service'), { recursive: true });
  writeFileSync(
    join(home, 'service', 'service.json'),
    JSON.stringify({
      schema: 1,
      manager: 'systemd',
      installedAt: new Date().toISOString(),
      platform: 'linux',
      port: 7766,
      host: null,
      dir: home,
      dsvmHome: home,
      dsvmBin: '/nonexistent/dsvm.js',
      nodePath: process.execPath,
      pathEnv: '',
    }),
  );
  writeFileSync(
    join(home, 'service', 'url.json'),
    JSON.stringify({
      schema: 1,
      url: URL,
      pid,
      dsvmPid: pid,
      port: 7766,
      version: '9.9.9',
      startedAt: new Date().toISOString(),
    }),
  );
  return { home, xdg, fakebin };
}

test('dsvm open --print prints the URL and still opens it', skipNonLinux, async () => {
  const { home, xdg, fakebin } = setup(process.pid);
  const opened = join(fakebin, 'opened.txt');
  writeScript(join(fakebin, 'xdg-open'), 'printf \'%s\\n\' "$1" > "$OPEN_LOG"');
  const result = await runCli(home, ['open', '--print'], {
    XDG_CONFIG_HOME: xdg,
    PATH: `${fakebin}:${process.env.PATH ?? ''}`,
    OPEN_LOG: opened,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), URL);
  await waitFor(() => existsSync(opened), { what: 'opener invocation' });
  assert.equal(readFileSync(opened, 'utf8').trim(), URL);
});

test('dsvm open launches the platform opener without printing the URL', skipNonLinux, async () => {
  const { home, xdg, fakebin } = setup(process.pid);
  const opened = join(fakebin, 'opened.txt');
  writeScript(join(fakebin, 'xdg-open'), 'printf \'%s\\n\' "$1" > "$OPEN_LOG"');
  const result = await runCli(home, ['open'], {
    XDG_CONFIG_HOME: xdg,
    PATH: `${fakebin}:${process.env.PATH ?? ''}`,
    OPEN_LOG: opened,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /token/);
  assert.match(result.stdout, /opening the dsvm service in your default browser/);
  await waitFor(() => existsSync(opened), { what: 'opener invocation' });
  assert.equal(readFileSync(opened, 'utf8').trim(), URL);
});

test('dsvm open reports a stopped service', skipNonLinux, async () => {
  const { home, xdg, fakebin } = setup(999_999);
  writeScript(
    join(fakebin, 'systemctl'),
    "case \"$*\" in *is-active*) exit 3 ;; esac\nexit 0",
  );
  const result = await runCli(home, ['open'], {
    XDG_CONFIG_HOME: xdg,
    PATH: `${fakebin}:${process.env.PATH ?? ''}`,
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /not running/);
});
