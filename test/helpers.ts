import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DSVM_BIN = join(PROJECT_ROOT, 'bin', 'dsvm.js');

const createdDirs: string[] = [];
process.on('exit', () => {
  for (const dir of createdDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup.
    }
  }
});

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dsvm-${prefix}-`));
  createdDirs.push(dir);
  return dir;
}

export interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export function spawnCli(
  home: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawn> {
  return spawn(process.execPath, [DSVM_BIN, ...args], {
    env: { ...process.env, DSVM_HOME: home, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function runCli(home: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(home, args, env);
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

export function writeConfig(home: string, config: unknown): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

export function setCurrent(home: string, version = '9.9.9'): void {
  writeConfig(home, {
    schema: 1,
    current: { kind: 'version', spec: version, version },
    installed: { [version]: { installedAt: new Date().toISOString() } },
    tags: {},
  });
}

const FAKE_DSH_SCRIPT = `console.log('fake dsh argv: ' + process.argv.slice(2).join(' '));
if (process.env.FAKE_DSH_URL) console.log('dsh web: ' + process.env.FAKE_DSH_URL);
if (process.env.FAKE_DSH_HOLD === '1') {
  setInterval(() => {}, 1000);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
} else {
  process.exit(Number(process.env.FAKE_DSH_EXIT ?? 0));
}
`;

/** Create a fake installed dsh version that behaves like a tiny `dsh web`. */
export function addFakeDsh(home: string, version = '9.9.9'): string {
  const dshDir = join(home, 'versions', version, 'node_modules', '@deepseek-ai', 'dsh');
  const libDir = join(dshDir, 'lib');
  mkdirSync(libDir, { recursive: true });
  const bin = join(libDir, 'bin.js');
  writeFileSync(bin, FAKE_DSH_SCRIPT);
  writeFileSync(
    join(dshDir, 'package.json'),
    `${JSON.stringify({ name: '@deepseek-ai/dsh', version }, null, 2)}\n`,
  );
  return bin;
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 8000, intervalMs = 25, what = 'condition' } = {},
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** A POSIX shell script that logs its arguments and exits with a fixed code. */
export function writeScript(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}
