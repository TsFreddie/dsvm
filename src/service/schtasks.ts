import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { serviceDir, serviceUrlFile } from '../paths.js';
import { mkdirp, pidAlive, quoteWindowsArg, readJson, run } from '../util.js';
import type { RunResult } from '../util.js';
import type { ManagerId, ServiceMeta, ServiceState } from './types.js';

export const id: ManagerId = 'schtasks';
export const label = 'Windows scheduled task';
export const taskName = 'dsvm';
const DESCRIPTION = 'DeepSeek Harness Web UI managed by dsvm';

export function location(): string {
  return join(serviceDir(), 'dsvm-run.cmd');
}

function ps(script: string, options: { allowFailure?: boolean } = {}): Promise<RunResult> {
  return run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    options,
  );
}

/** Escape a value for a PowerShell single-quoted string. */
function sq(value: string): string {
  return String(value).replace(/'/g, "''");
}

/** Escape a value used inside a batch `set "VAR=value"` statement. */
function batchEscape(value: string): string {
  return String(value).replace(/%/g, '%%');
}

export function renderWrapper(meta: ServiceMeta): string {
  const args = ['--port', String(meta.port)];
  if (meta.host) args.push('--host', meta.host);
  args.push('--no-open');
  const lines = [
    '@echo off',
    'setlocal',
    'set "DSVM_SERVICE=1"',
    `set "DSVM_HOME=${batchEscape(meta.dsvmHome)}"`,
    `set "PATH=${batchEscape(meta.pathEnv)}"`,
    `"${meta.nodePath}" "${meta.dsvmBin}" web ${args.map(quoteWindowsArg).join(' ')}`,
    'exit /b %ERRORLEVEL%',
    '',
  ];
  return lines.join('\r\n');
}

export async function isInstalled(): Promise<boolean> {
  const result = await ps(
    `if (Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue) { 'yes' }`,
    { allowFailure: true },
  );
  return result.code === 0 && result.stdout.trim() === 'yes';
}

export async function install(meta: ServiceMeta): Promise<void> {
  mkdirp(dirname(location()));
  writeFileSync(location(), renderWrapper(meta), { mode: 0o755 });
  const script = [
    `$action = New-ScheduledTaskAction -Execute '${sq(location())}'`,
    '$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME',
    '$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType Interactive -RunLevel Limited',
    '$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew',
    `Register-ScheduledTask -TaskName '${taskName}' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description '${sq(DESCRIPTION)}' -Force | Out-Null`,
    `Disable-ScheduledTask -TaskName '${taskName}' | Out-Null`,
  ].join('; ');
  await ps(script);
}

export async function enable(): Promise<void> {
  await ps(
    `Enable-ScheduledTask -TaskName '${taskName}' | Out-Null; Start-ScheduledTask -TaskName '${taskName}'`,
  );
}

export async function disable(): Promise<void> {
  await ps(
    `Stop-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue; Disable-ScheduledTask -TaskName '${taskName}' | Out-Null`,
    { allowFailure: true },
  );
}

export async function start(): Promise<void> {
  await ps(`Start-ScheduledTask -TaskName '${taskName}'`);
}

async function killRecordedPid(): Promise<void> {
  const state = readJson<ServiceState | null>(serviceUrlFile(), null);
  if (state?.pid && pidAlive(state.pid)) {
    await run('taskkill', ['/PID', String(state.pid), '/T', '/F'], { allowFailure: true });
  }
}

export async function stop(): Promise<void> {
  await ps(`Stop-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue`, {
    allowFailure: true,
  });
  await killRecordedPid();
}

export async function restart(): Promise<void> {
  await stop();
  await start();
}

export async function state(): Promise<string> {
  const result = await ps(
    `(Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue).State`,
    { allowFailure: true },
  );
  return result.stdout.trim() || 'not installed';
}

export async function isRunning(): Promise<boolean> {
  return (await state()) === 'Running';
}

export async function uninstall(): Promise<void> {
  await stop();
  await ps(`Unregister-ScheduledTask -TaskName '${taskName}' -Confirm:$false`, {
    allowFailure: true,
  });
  rmSync(location(), { force: true });
  rmSync(serviceUrlFile(), { force: true });
}
