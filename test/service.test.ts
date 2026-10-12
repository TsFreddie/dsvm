import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addFakeDsh, runCli, tempDir, writeScript, PROJECT_ROOT } from './helpers.js';

const skipNonLinux = { skip: process.platform !== 'linux' };

function setup() {
  const home = tempDir('service');
  const xdg = tempDir('service-xdg');
  const fakebin = tempDir('service-bin');
  const log = join(fakebin, 'systemctl.log');
  writeScript(
    join(fakebin, 'systemctl'),
    `printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
case "$*" in
  *is-active*)
    if [ "\${SYSTEMCTL_ACTIVE:-0}" = "1" ]; then exit 0; fi
    case "$*" in *--quiet*) ;; *) printf 'inactive\\n' ;; esac
    exit 3
    ;;
esac
exit 0`,
  );
  const env = {
    PATH: `${fakebin}:${process.env.PATH ?? ''}`,
    XDG_CONFIG_HOME: xdg,
    SYSTEMCTL_LOG: log,
  };
  const unitPath = join(xdg, 'systemd', 'user', 'dsvm.service');
  return { home, xdg, fakebin, log, env, unitPath };
}

test('systemd service install/enable/url/uninstall lifecycle', skipNonLinux, async () => {
  const { home, env, log, unitPath } = setup();

  const install = await runCli(home, ['service', 'install', '--port', '17766'], env);
  assert.equal(install.code, 0, install.stderr);
  const unit = readFileSync(unitPath, 'utf8');
  assert.ok(
    unit.includes(`ExecStart=${process.execPath} ${join(PROJECT_ROOT, 'bin', 'dsvm.js')} web --port 17766 --no-open`),
    unit,
  );
  assert.ok(unit.includes(`Environment="DSVM_HOME=${home}"`));
  assert.match(unit, /Environment="DSVM_SERVICE=1"/);
  assert.ok(readFileSync(log, 'utf8').includes('daemon-reload'));

  const again = await runCli(home, ['service', 'install'], env);
  assert.notEqual(again.code, 0);
  assert.match(again.stderr, /already installed/);

  const url = await runCli(home, ['service', 'url'], { ...env, SYSTEMCTL_ACTIVE: '0' });
  assert.notEqual(url.code, 0);
  assert.match(url.stderr, /not running/);

  const enable = await runCli(home, ['service', 'enable'], env);
  assert.equal(enable.code, 0, enable.stderr);
  assert.ok(readFileSync(log, 'utf8').includes('enable --now dsvm.service'));

  const status = await runCli(home, ['service', 'status'], { ...env, SYSTEMCTL_ACTIVE: '1' });
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /manager: systemd user unit/);

  const uninstall = await runCli(home, ['service', 'uninstall'], env);
  assert.equal(uninstall.code, 0, uninstall.stderr);
  assert.equal(existsSync(unitPath), false);
  assert.equal(existsSync(join(home, 'service', 'service.json')), false);

  const missing = await runCli(home, ['service', 'disable'], env);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /not installed/);
});

test('service url reports a running service without a URL', skipNonLinux, async () => {
  const { home, env } = setup();
  const install = await runCli(home, ['service', 'install'], env);
  assert.equal(install.code, 0, install.stderr);
  const url = await runCli(home, ['service', 'url'], { ...env, SYSTEMCTL_ACTIVE: '1' });
  assert.notEqual(url.code, 0);
  assert.match(url.stderr, /has not reported its web URL/);
});

test('switching versions reminds the user to restart a running service', skipNonLinux, async () => {
  const { home, env } = setup();
  addFakeDsh(home, '9.9.9');
  const install = await runCli(home, ['service', 'install'], env);
  assert.equal(install.code, 0, install.stderr);
  const use = await runCli(home, ['use', '9.9.9'], { ...env, SYSTEMCTL_ACTIVE: '1' });
  assert.equal(use.code, 0, use.stderr);
  assert.match(use.stdout, /dsvm service restart/);
});
