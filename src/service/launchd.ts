import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdirp, run, writeTextAtomic } from '../util.js';
import { serviceLogsDir } from '../paths.js';
import type { ManagerId, ServiceMeta } from './types.js';

export const id: ManagerId = 'launchd';
export const label = 'launchd LaunchAgent';
export const labelId = 'com.dsvm.service';

export function location(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${labelId}.plist`);
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

function serviceTarget(): string {
  return `${domain()}/${labelId}`;
}

function xmlEscape(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderPlist(meta: ServiceMeta): string {
  const args = [meta.nodePath, meta.dsvmBin, 'web', '--port', String(meta.port)];
  if (meta.host) args.push('--host', meta.host);
  args.push('--no-open');
  const environment: Record<string, string> = {
    DSVM_SERVICE: '1',
    DSVM_HOME: meta.dsvmHome,
    PATH: meta.pathEnv,
  };
  const stdoutPath = join(serviceLogsDir(), 'service.out.log');
  const stderrPath = join(serviceLogsDir(), 'service.err.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xmlEscape(labelId)}</string>
\t<key>ProgramArguments</key>
\t<array>
${args.map((arg) => `\t\t<string>${xmlEscape(arg)}</string>`).join('\n')}
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
${Object.entries(environment)
  .map(([key, value]) => `\t\t<key>${xmlEscape(key)}</key>\n\t\t<string>${xmlEscape(value)}</string>`)
  .join('\n')}
\t</dict>
\t<key>WorkingDirectory</key>
\t<string>${xmlEscape(meta.dir)}</string>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>StandardOutPath</key>
\t<string>${xmlEscape(stdoutPath)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xmlEscape(stderrPath)}</string>
</dict>
</plist>
`;
}

export function isInstalled(): boolean {
  return existsSync(location());
}

async function isLoaded(): Promise<boolean> {
  const result = await run('launchctl', ['print', serviceTarget()], { allowFailure: true });
  return result.code === 0;
}

export async function install(meta: ServiceMeta): Promise<void> {
  // Unload any previously loaded job so a changed definition (for example a
  // new port) takes effect at the next bootstrap. Harmless when not loaded.
  await run('launchctl', ['bootout', serviceTarget()], { allowFailure: true });
  mkdirp(dirname(location()));
  mkdirp(serviceLogsDir());
  writeTextAtomic(location(), renderPlist(meta), 0o644);
}

export async function enable(): Promise<void> {
  if (!(await isLoaded())) {
    await run('launchctl', ['bootstrap', domain(), location()]);
  }
  await run('launchctl', ['enable', serviceTarget()], { allowFailure: true });
}

export async function disable(): Promise<void> {
  await run('launchctl', ['bootout', serviceTarget()], { allowFailure: true });
  await run('launchctl', ['disable', serviceTarget()], { allowFailure: true });
}

export async function start(): Promise<void> {
  if (!(await isLoaded())) {
    await run('launchctl', ['bootstrap', domain(), location()]);
    return;
  }
  await run('launchctl', ['kickstart', serviceTarget()], { allowFailure: true });
}

export async function stop(): Promise<void> {
  if (await isLoaded()) {
    await run('launchctl', ['kill', 'SIGTERM', serviceTarget()], { allowFailure: true });
  }
}

export async function restart(): Promise<void> {
  if (!(await isLoaded())) {
    await run('launchctl', ['bootstrap', domain(), location()]);
    return;
  }
  await run('launchctl', ['kickstart', '-k', serviceTarget()]);
}

export async function isRunning(): Promise<boolean> {
  const result = await run('launchctl', ['print', serviceTarget()], { allowFailure: true });
  return result.code === 0 && /\bstate = running\b/.test(result.stdout);
}

export async function state(): Promise<string> {
  const result = await run('launchctl', ['print', serviceTarget()], { allowFailure: true });
  if (result.code !== 0) return 'not loaded';
  const match = result.stdout.match(/\bstate = (\w+)/);
  return match ? (match[1] ?? 'loaded') : 'loaded';
}

export async function uninstall(): Promise<void> {
  await disable();
  rmSync(location(), { force: true });
  await run('launchctl', ['enable', serviceTarget()], { allowFailure: true });
}
