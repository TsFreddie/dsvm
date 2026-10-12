import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readConfig } from '../config.js';
import { dsvmBinPath, dsvmHome, serviceConfigFile, serviceUrlFile } from '../paths.js';
import {
  DsvmError,
  expandTilde,
  fail,
  info,
  parsePort,
  pidAlive,
  readJson,
  rmrf,
  warn,
  writeJsonAtomic,
} from '../util.js';
import * as launchd from './launchd.js';
import * as schtasks from './schtasks.js';
import * as systemd from './systemd.js';
import type { ManagerId, ServiceManager, ServiceMeta, ServiceState } from './types.js';

export type { ServiceMeta, ServiceState } from './types.js';

export class ServiceNotInstalledError extends DsvmError {
  constructor(message = 'dsvm service is not installed; run `dsvm service install` first') {
    super(message);
    this.name = 'ServiceNotInstalledError';
  }
}

const MANAGERS: Record<ManagerId, ServiceManager> = { systemd, launchd, schtasks };

export function managerForPlatform(platform: NodeJS.Platform = process.platform): ServiceManager {
  if (platform === 'linux') return systemd;
  if (platform === 'darwin') return launchd;
  if (platform === 'win32') return schtasks;
  throw new DsvmError(
    `dsvm service does not support platform "${platform}" (supported: Linux/systemd, macOS/launchd, Windows/Task Scheduler)`,
  );
}

export function readServiceMeta(): ServiceMeta | null {
  return readJson<ServiceMeta | null>(serviceConfigFile(), null);
}

export function writeServiceMeta(meta: ServiceMeta): void {
  writeJsonAtomic(serviceConfigFile(), meta, 0o600);
}

export function readServiceState(): ServiceState | null {
  return readJson<ServiceState | null>(serviceUrlFile(), null);
}

export function writeServiceState(state: ServiceState): void {
  writeJsonAtomic(serviceUrlFile(), state, 0o600);
}

export function clearServiceState(): void {
  rmrf(serviceUrlFile());
}

async function requireInstalled(): Promise<{ meta: ServiceMeta; manager: ServiceManager }> {
  const meta = readServiceMeta();
  if (!meta || typeof meta.manager !== 'string') throw new ServiceNotInstalledError();
  const manager = MANAGERS[meta.manager] ?? managerForPlatform();
  if (!(await manager.isInstalled())) throw new ServiceNotInstalledError();
  return { meta, manager };
}

/** Whether the service is installed and currently running. Never throws. */
export async function isServiceRunning(): Promise<boolean> {
  try {
    const { manager } = await requireInstalled();
    return await manager.isRunning();
  } catch {
    return false;
  }
}

/** URL of the running service instance, as reported by its `dsvm web` process. */
export async function serviceUrl(): Promise<string> {
  const { manager } = await requireInstalled();
  const state = readServiceState();
  if (state?.url && pidAlive(state.pid)) return state.url;
  if (await manager.isRunning().catch(() => false)) {
    throw new DsvmError(
      'the dsvm service is running but has not reported its web URL yet; try again in a moment',
    );
  }
  throw new DsvmError(
    'the dsvm service is not running; start it with `dsvm service enable` or `dsvm service start`',
  );
}

interface InstallOptions {
  port: number;
  host: string | null;
  dir: string;
  force: boolean;
}

function parseInstallArgs(args: string[]): InstallOptions {
  const options: InstallOptions = { port: 7766, host: null, dir: homedir(), force: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--port') {
      const value = args[index + 1];
      if (value === undefined) fail('--port requires a value');
      options.port = parsePort(value);
      index += 1;
    } else if (arg === '--host') {
      const value = args[index + 1];
      if (value === undefined || value === '') fail('--host requires a value');
      options.host = value;
      index += 1;
    } else if (arg === '--dir') {
      const value = args[index + 1];
      if (value === undefined || value === '') fail('--dir requires a value');
      options.dir = resolve(expandTilde(value));
      index += 1;
    } else if (arg === '--force' || arg === '-f') {
      options.force = true;
    } else {
      fail(`unknown option "${arg}" for \`dsvm service install\``);
    }
  }
  if (!existsSync(options.dir) || !statSync(options.dir).isDirectory()) {
    fail(`working directory does not exist: ${options.dir}`);
  }
  return options;
}

function buildMeta(options: InstallOptions): ServiceMeta {
  const manager = managerForPlatform();
  return {
    schema: 1,
    manager: manager.id,
    installedAt: new Date().toISOString(),
    platform: process.platform,
    port: options.port,
    host: options.host,
    dir: options.dir,
    dsvmHome: dsvmHome(),
    dsvmBin: dsvmBinPath(),
    nodePath: process.execPath,
    pathEnv: process.env.PATH ?? '',
  };
}

async function installService(options: InstallOptions): Promise<void> {
  const manager = managerForPlatform();
  const alreadyInstalled = await manager.isInstalled();
  if (alreadyInstalled && !options.force) {
    fail(`dsvm service is already installed (${manager.location()}); use --force to reinstall`);
  }
  if (!readConfig().current) {
    warn('no active dsh version is set; the service will not start until you run `dsvm install`');
  }
  const meta = buildMeta(options);
  if (alreadyInstalled) {
    try {
      await manager.stop();
    } catch {
      // The old definition is about to be replaced.
    }
    clearServiceState();
  }
  await manager.install(meta);
  writeServiceMeta(meta);
  info(`installed ${manager.label} for dsvm (port ${meta.port})`);
  info('run `dsvm service enable` to start it now and enable start at login,');
  info('or `dsvm service start` to start it now only');
  info('once running: `dsvm service url` prints the URL, `dsvm open` opens it');
}

async function statusService(options: { json: boolean }): Promise<void> {
  const { meta, manager } = await requireInstalled();
  const state = await manager.state().catch(() => 'unknown');
  let url: string | null = null;
  try {
    url = await serviceUrl();
  } catch {
    url = null;
  }
  if (options.json) {
    info(JSON.stringify({ manager: meta.manager, state, port: meta.port, url }, null, 2));
    return;
  }
  info(`manager: ${manager.label}`);
  info(`state:   ${state}`);
  info(`port:    ${meta.port}`);
  info(`url:     ${url ?? '(not available)'}`);
}

export function serviceHelpText(): string {
  return [
    'Manage the dsvm background service that serves the dsh web UI.',
    '',
    'The service runs `dsvm web --port <port> --no-open` through the platform',
    'service manager, so switching dsh versions only needs `dsvm service restart`.',
    '',
    'Subcommands:',
    '  install [--port <port>] [--host <host>] [--dir <dir>] [--force]',
    '                       Install the service definition (default port 7766)',
    '  enable               Start the service now and at login',
    '  disable              Stop the service and disable start at login',
    '  start                Start the service now',
    '  stop                 Stop the service',
    '  restart              Restart the service (applies the active dsh version)',
    '  status [--json]      Show the service state and its web URL',
    '  url                  Print the web URL of the running service',
    '  uninstall            Remove the service definition',
    '',
    'Platforms: systemd user unit (Linux), launchd LaunchAgent (macOS),',
    'Windows Task Scheduler task.',
  ].join('\n');
}

export async function serviceCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    info(serviceHelpText());
    return;
  }
  switch (subcommand) {
    case 'install':
      return installService(parseInstallArgs(rest));
    case 'enable': {
      const { manager } = await requireInstalled();
      clearServiceState();
      await manager.enable();
      info(`dsvm service enabled and started (${manager.label})`);
      return;
    }
    case 'disable': {
      const { manager } = await requireInstalled();
      await manager.disable();
      clearServiceState();
      info('dsvm service disabled and stopped');
      return;
    }
    case 'start': {
      const { manager } = await requireInstalled();
      clearServiceState();
      await manager.start();
      info('dsvm service started');
      return;
    }
    case 'stop': {
      const { manager } = await requireInstalled();
      await manager.stop();
      clearServiceState();
      info('dsvm service stopped');
      return;
    }
    case 'restart': {
      const { manager } = await requireInstalled();
      clearServiceState();
      await manager.restart();
      info('dsvm service restarted');
      return;
    }
    case 'status':
      return statusService({ json: rest.includes('--json') });
    case 'url':
      info(await serviceUrl());
      return;
    case 'uninstall': {
      const { manager } = await requireInstalled();
      await manager.uninstall();
      clearServiceState();
      rmrf(serviceConfigFile());
      info(`uninstalled dsvm service (${manager.label})`);
      return;
    }
    default:
      fail(`unknown service subcommand "${subcommand}"\n\n${serviceHelpText()}`);
  }
}
