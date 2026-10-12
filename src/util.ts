import { spawn } from 'node:child_process';
import type { StdioOptions } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const isWindows = process.platform === 'win32';
export const isMac = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';

/** Expected user error; printed as `dsvm: <message>` without a stack trace. */
export class DsvmError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DsvmError';
  }
}

export function fail(message: string): never {
  throw new DsvmError(message);
}

const colorEnabled = (): boolean =>
  process.stdout.isTTY === true &&
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb';

const paint = (code: string, text: string): string =>
  colorEnabled() ? `\u001b[${code}m${text}\u001b[0m` : text;

export const bold = (text: string): string => paint('1', text);
export const dim = (text: string): string => paint('2', text);
export const red = (text: string): string => paint('31', text);
export const green = (text: string): string => paint('32', text);
export const yellow = (text: string): string => paint('33', text);
export const cyan = (text: string): string => paint('36', text);

export function info(message = ''): void {
  process.stdout.write(`${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`${yellow('warning:')} ${message}\n`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RunOptions {
  stdio?: StdioOptions;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  allowFailure?: boolean;
  input?: string;
  shell?: boolean;
}

export interface RunResult {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Run a command capturing its output. Rejects with a DsvmError on a non-zero
 * exit unless `allowFailure` is set.
 */
export function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const { stdio = 'pipe', env, cwd, allowFailure = false, input, shell = false } = options;
  const useShell = shell && isWindows;
  const spawnCommand = useShell ? [command, ...args].map(quoteWindowsArg).join(' ') : command;
  const spawnArgs = useShell ? [] : [...args];
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(spawnCommand, spawnArgs, {
        stdio: input === undefined ? stdio : ['pipe', 'pipe', 'pipe'],
        env: env ?? process.env,
        cwd,
        shell: useShell,
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    if (child.stdout) child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    if (child.stderr) child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    if (input !== undefined && child.stdin) child.stdin.end(input);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const result: RunResult = { code: code ?? (signal ? 1 : 0), signal, stdout, stderr };
      if (result.code !== 0 && !allowFailure) {
        const detail = (stderr || stdout).trim();
        const rendered = [command, ...args].join(' ');
        reject(new DsvmError(`${rendered} exited with code ${result.code}${detail ? `:\n${detail}` : ''}`));
      } else {
        resolve(result);
      }
    });
  });
}

/** Run a command inheriting stdio (used for interactive installers). */
export function runInherit(command: string, args: readonly string[], options: RunOptions = {}): Promise<number> {
  const { env, cwd, shell = false } = options;
  const useShell = shell && isWindows;
  const spawnCommand = useShell ? [command, ...args].map(quoteWindowsArg).join(' ') : command;
  const spawnArgs = useShell ? [] : [...args];
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(spawnCommand, spawnArgs, {
        stdio: 'inherit',
        env: env ?? process.env,
        cwd,
        shell: useShell,
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.on('error', reject);
    child.on('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

export function commandExists(command: string): boolean {
  if (command.includes('/') || command.includes('\\')) return existsSync(command);
  const pathValue = process.env.PATH ?? '';
  const dirs = pathValue.split(isWindows ? ';' : ':');
  const exts = isWindows
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      if (existsSync(join(dir, command + ext))) return true;
    }
  }
  return false;
}

export function mkdirp(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function rmrf(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function readJson<T>(file: string, fallback: T): T {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new DsvmError(`cannot parse ${file}: ${(error as Error).message}`);
  }
}

export function writeJsonAtomic(file: string, value: unknown, mode?: number): void {
  mkdirp(dirname(file));
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, mode === undefined ? undefined : { mode });
  renameSync(temp, file);
}

export function writeTextAtomic(file: string, text: string, mode?: number): void {
  mkdirp(dirname(file));
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, text, mode === undefined ? undefined : { mode });
  renameSync(temp, file);
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function expandTilde(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return path;
}

export function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`invalid port "${value}" (expected an integer between 1 and 65535)`);
  }
  return port;
}

export function formatTimestamp(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

export interface NpmCommand {
  command: string;
  prefixArgs: string[];
  shell: boolean;
}

/** npm may be a symlink to a JS file; prefer the npm-cli.js next to node itself. */
export function npmCommand(): NpmCommand {
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return { command: process.execPath, prefixArgs: [candidate], shell: false };
    }
  }
  if (isWindows) return { command: 'npm.cmd', prefixArgs: [], shell: true };
  return { command: 'npm', prefixArgs: [], shell: false };
}

/** Quote a single argument for cmd.exe / CommandLineToArgvW. */
export function quoteWindowsArg(argument: string): string {
  if (argument === '') return '""';
  if (!/[\s"&|<>^()%!,;=]/.test(argument)) return argument;
  return `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}
