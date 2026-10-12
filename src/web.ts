import { spawn } from 'node:child_process';
import { activeDsh } from './versions.js';
import { clearServiceState, readServiceState, writeServiceState } from './service/index.js';
import { DsvmError, isLinux, warn } from './util.js';

const URL_LINE_RE = /^dsh web:\s+(https?:\/\/\S+)\s*$/;
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const SHUTDOWN_GRACE_MS = 3000;

type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

function exitCodeForSignal(signal: string): number {
  return 128 + (SIGNAL_NUMBERS[signal] ?? 0);
}

export function isServiceMode(): boolean {
  const value = process.env.DSVM_SERVICE;
  return value === '1' || value === 'true' || value === 'yes';
}

function portFromArgs(args: string[]): number | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--port') {
      const port = Number(args[index + 1]);
      return Number.isInteger(port) && port > 0 ? port : null;
    }
    if (arg.startsWith('--port=')) {
      const port = Number(arg.slice('--port='.length));
      return Number.isInteger(port) && port > 0 ? port : null;
    }
  }
  return null;
}

/**
 * `dsvm web` — boot one `dsh web` instance using the active version.
 *
 * Outside service mode the process is handed over to dsh (execve when
 * available, otherwise a foreground child with inherited stdio). In service
 * mode (`DSVM_SERVICE=1`, set by the installed unit) stdout is additionally
 * scanned for the `dsh web: <url>` line so `dsvm service url` can hand the
 * per-process authenticated URL to other commands.
 */
export async function webCommand(args: string[]): Promise<void> {
  const { version, bin } = activeDsh();
  const dshArgs = [bin, 'web', ...args];
  if (isServiceMode()) return runServiceWeb({ version, dshArgs, args });
  return handoff({ dshArgs });
}

/**
 * Replace this process with `dsh`, or fall back to a foreground child.
 * Shared by `dsvm web` (foreground mode) and other pure passthrough
 * commands such as `dsvm plugin`.
 */
export async function handoff({ dshArgs }: { dshArgs: string[] }): Promise<void> {
  if (process.platform !== 'win32' && typeof process.execve === 'function') {
    try {
      process.execve(process.execPath, [process.execPath, ...dshArgs], { ...process.env });
    } catch (error) {
      warn(`could not hand off to dsh directly (${(error as Error).message}); spawning it instead`);
    }
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, dshArgs, {
      stdio: 'inherit',
      env: process.env,
      windowsHide: true,
    });
    for (const signal of SHUTDOWN_SIGNALS) {
      process.on(signal, () => {
        try {
          child.kill(signal);
        } catch {
          // The child is already gone.
        }
      });
    }
    child.on('error', (error) => {
      reject(new DsvmError(`failed to start dsh: ${error.message}`));
    });
    child.on('close', (code, signal) => {
      process.exitCode = code ?? (signal ? exitCodeForSignal(signal) : 1);
      resolve();
    });
  });
}

async function runServiceWeb({
  version,
  dshArgs,
  args,
}: {
  version: string;
  dshArgs: string[];
  args: string[];
}): Promise<void> {
  clearServiceState();
  const port = portFromArgs(args);
  const child = spawn(process.execPath, dshArgs, {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: process.env,
    windowsHide: true,
  });

  const ownsState = (): boolean => {
    const state = readServiceState();
    return state !== null && (state.dsvmPid === process.pid || state.pid === child.pid);
  };
  const cleanup = (): void => {
    try {
      if (ownsState()) clearServiceState();
    } catch {
      // Best effort: a stale state file with a dead pid is ignored anyway.
    }
  };
  process.on('exit', cleanup);

  child.stdout?.setEncoding('utf8');
  let buffer = '';
  child.stdout?.on('data', (chunk: string) => {
    process.stdout.write(chunk);
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      const match = line.match(URL_LINE_RE);
      if (!match) continue;
      try {
        writeServiceState({
          schema: 1,
          url: match[1] as string,
          pid: child.pid ?? 0,
          dsvmPid: process.pid,
          port,
          version,
          startedAt: new Date().toISOString(),
        });
      } catch (error) {
        warn(`could not record the service URL: ${(error as Error).message}`);
      }
    }
  });

  const finished = new Promise<number>((resolve, reject) => {
    child.on('error', (error) => reject(new DsvmError(`failed to start dsh: ${error.message}`)));
    child.on('close', (code, signal) => resolve(code ?? (signal ? exitCodeForSignal(signal) : 1)));
  });

  let shuttingDown = false;
  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      // On Linux systemd signals every process in the cgroup itself; launchd
      // and the Windows Task Scheduler only signal the main process.
      if (!isLinux) {
        try {
          child.kill(signal as ShutdownSignal);
        } catch {
          // The child is already gone.
        }
      }
      const force = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // The child is already gone.
        }
        cleanup();
        process.exit(exitCodeForSignal(signal));
      }, SHUTDOWN_GRACE_MS);
      force.unref();
      finished.then(() => {
        clearTimeout(force);
        cleanup();
        process.exit(exitCodeForSignal(signal));
      });
    });
  }

  const code = await finished;
  cleanup();
  process.exitCode = code;
}
