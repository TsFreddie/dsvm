import test from 'node:test';
import assert from 'node:assert/strict';
import { renderUnit } from '../src/service/systemd.js';
import { renderPlist, labelId } from '../src/service/launchd.js';
import { renderWrapper, taskName } from '../src/service/schtasks.js';
import { dsvmBinPath } from '../src/paths.js';
import type { ServiceMeta } from '../src/service/types.js';
import { existsSync } from 'node:fs';

const meta: ServiceMeta = {
  schema: 1,
  manager: 'systemd',
  installedAt: '2025-01-01T00:00:00.000Z',
  platform: 'linux',
  port: 7766,
  host: null,
  dir: '/home/user/my dir',
  dsvmHome: '/home/user/.dsvm',
  dsvmBin: '/home/user/.dsvm/lib/dsvm.js',
  nodePath: '/usr/bin/node',
  pathEnv: '/usr/bin:/bin',
};

test('systemd unit runs dsvm web with the service environment', () => {
  const unit = renderUnit(meta);
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/home\/user\/\.dsvm\/lib\/dsvm\.js web --port 7766 --no-open/);
  assert.match(unit, /WorkingDirectory="\/home\/user\/my dir"/);
  assert.match(unit, /Environment="DSVM_SERVICE=1"/);
  assert.match(unit, /Environment="DSVM_HOME=\/home\/user\/\.dsvm"/);
  assert.match(unit, /Environment="PATH=\/usr\/bin:\/bin"/);
  assert.match(unit, /WantedBy=default\.target/);
});

test('dsvmBinPath points at the real launcher shim', () => {
  const bin = dsvmBinPath();
  assert.ok(existsSync(bin), `expected ${bin} to exist`);
  assert.match(bin, /bin[\/\\]dsvm\.js$/);
  assert.doesNotMatch(bin, /build[\/\\]bin[\/\\]dsvm\.js$/);
});

test('systemd unit renders an explicit host', () => {
  const unit = renderUnit({ ...meta, host: '127.0.0.1' });
  assert.match(unit, /web --port 7766 --host 127\.0\.0\.1 --no-open/);
});

test('systemd environment values keep literal percent signs', () => {
  const unit = renderUnit({ ...meta, pathEnv: '/opt/100%/bin' });
  assert.match(unit, /Environment="PATH=\/opt\/100%\/bin"/);
});

test('launchd plist escapes XML and carries the environment', () => {
  const plist = renderPlist({ ...meta, dir: '/Users/a&b', dsvmHome: '/Users/a&b/.dsvm' });
  assert.match(plist, new RegExp(`<string>${labelId}</string>`));
  assert.match(plist, /<key>DSVM_SERVICE<\/key>\s*<string>1<\/string>/);
  assert.match(plist, /<key>DSVM_HOME<\/key>\s*<string>\/Users\/a&amp;b\/\.dsvm<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>/);
  assert.match(plist, /<\/plist>/);
});

test('Windows wrapper sets the service environment and launches dsvm web', () => {
  const wrapper = renderWrapper(
    { ...meta, manager: 'schtasks', platform: 'win32', dir: 'C:\\Users\\u', dsvmHome: 'C:\\Users\\u\\.dsvm', dsvmBin: 'C:\\Users\\u\\.dsvm\\bin\\dsvm.js', nodePath: 'C:\\Program Files\\nodejs\\node.exe', pathEnv: 'C:\\Windows;C:\\Tools' },
  );
  assert.ok(wrapper.startsWith('@echo off\r\n'));
  assert.ok(wrapper.includes('set "DSVM_SERVICE=1"'));
  assert.ok(wrapper.includes('set "DSVM_HOME=C:\\Users\\u\\.dsvm"'));
  assert.ok(wrapper.includes('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\u\\.dsvm\\bin\\dsvm.js" web --port 7766 --no-open'));
  assert.match(taskName, /^dsvm$/);
});
