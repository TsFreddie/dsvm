import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdirp, run, writeTextAtomic } from '../util.js';
import type { RunOptions, RunResult } from '../util.js';
import type { ManagerId, ServiceMeta } from './types.js';

export const id: ManagerId = 'systemd';
export const label = 'systemd user unit';
export const unitName = 'dsvm.service';

export function location(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'systemd', 'user', unitName);
}

function systemctl(args: readonly string[], options?: RunOptions): Promise<RunResult> {
  return run('systemctl', ['--user', ...args], options);
}

/** Escape one ExecStart argument for systemd. */
function sdArg(value: string): string {
  const escaped = String(value).replace(/%/g, '%%');
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(escaped)) return escaped;
  return `"${escaped.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Quote one Environment= value (systemd unquotes double quotes; `%` is literal here). */
function sdEnv(key: string, value: string): string {
  const escaped = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  return `Environment="${key}=${escaped}"`;
}

export function renderUnit(meta: ServiceMeta): string {
  const args = [meta.nodePath, meta.dsvmBin, 'web', '--port', String(meta.port)];
  if (meta.host) args.push('--host', meta.host);
  args.push('--no-open');

  const lines = [
    '[Unit]',
    'Description=DeepSeek Harness Web UI (managed by dsvm)',
    'After=network.target',
    'StartLimitIntervalSec=60',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Type=simple',
    '# dsvm resolves the active dsh version at start time;',
    '# run `dsvm service restart` after switching versions.',
    `ExecStart=${args.map(sdArg).join(' ')}`,
    `WorkingDirectory=${sdArg(meta.dir)}`,
    sdEnv('DSVM_SERVICE', '1'),
    sdEnv('DSVM_HOME', meta.dsvmHome),
    sdEnv('PATH', meta.pathEnv),
    'Restart=on-failure',
    'RestartSec=2',
    'TimeoutStopSec=20',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ];
  return lines.join('\n');
}

export function isInstalled(): boolean {
  return existsSync(location());
}

export async function install(meta: ServiceMeta): Promise<void> {
  mkdirp(dirname(location()));
  writeTextAtomic(location(), renderUnit(meta), 0o644);
  await run('systemctl', ['--user', 'daemon-reload'], { allowFailure: true });
}

export async function enable(): Promise<void> {
  await run('systemctl', ['--user', 'daemon-reload'], { allowFailure: true });
  await systemctl(['enable', '--now', unitName]);
}

export async function disable(): Promise<void> {
  await systemctl(['disable', '--now', unitName]);
}

export async function start(): Promise<void> {
  await systemctl(['start', unitName]);
}

export async function stop(): Promise<void> {
  await systemctl(['stop', unitName]);
}

export async function restart(): Promise<void> {
  await systemctl(['restart', unitName]);
}

export async function isRunning(): Promise<boolean> {
  const result = await systemctl(['is-active', '--quiet', unitName], { allowFailure: true });
  return result.code === 0;
}

export async function state(): Promise<string> {
  const result = await systemctl(['is-active', unitName], { allowFailure: true });
  return result.stdout.trim() || 'inactive';
}

export async function uninstall(): Promise<void> {
  await systemctl(['disable', '--now', unitName], { allowFailure: true });
  rmSync(location(), { force: true });
  await run('systemctl', ['--user', 'daemon-reload'], { allowFailure: true });
}
