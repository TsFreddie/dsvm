import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configFile, dsvmHome, lockFile } from './paths.js';
import { DsvmError, mkdirp, readJson, rmrf, sleep, writeJsonAtomic } from './util.js';

export interface CurrentSelection {
  kind: 'tag' | 'version';
  spec: string;
  version: string;
}

export interface InstalledVersion {
  installedAt?: string;
  tag?: string | null;
}

export interface Config {
  schema: 1;
  current: CurrentSelection | null;
  installed: Record<string, InstalledVersion>;
  tags: Record<string, string>;
}

interface RawConfig {
  schema?: unknown;
  current?: unknown;
  installed?: unknown;
  tags?: unknown;
}

const EMPTY_CONFIG: Config = {
  schema: 1,
  current: null,
  installed: {},
  tags: {},
};

function normalizeCurrent(current: unknown): CurrentSelection | null {
  if (!current || typeof current !== 'object') return null;
  const candidate = current as Record<string, unknown>;
  if (typeof candidate.version !== 'string') return null;
  return {
    kind: candidate.kind === 'tag' ? 'tag' : 'version',
    spec: typeof candidate.spec === 'string' ? candidate.spec : candidate.version,
    version: candidate.version,
  };
}

export function readConfig(): Config {
  const raw = readJson<RawConfig | null>(configFile(), null);
  if (!raw || typeof raw !== 'object') return structuredClone(EMPTY_CONFIG);
  return {
    schema: 1,
    current: normalizeCurrent(raw.current),
    installed:
      raw.installed && typeof raw.installed === 'object'
        ? (raw.installed as Record<string, InstalledVersion>)
        : {},
    tags:
      raw.tags && typeof raw.tags === 'object'
        ? (raw.tags as Record<string, string>)
        : {},
  };
}

export function writeConfig(config: Config): void {
  mkdirp(dsvmHome());
  writeJsonAtomic(configFile(), { ...config, schema: 1 });
}

export function updateConfig(mutate: (config: Config) => Config | void): Config {
  const config = readConfig();
  const next = mutate(config) ?? config;
  writeConfig(next);
  return next;
}

const LOCK_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 30 * 60_000;

/**
 * Serialize dsvm state mutations across processes. The lock is a directory so
 * creation is atomic on every platform.
 */
export async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = lockFile();
  mkdirp(dsvmHome());
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, 'pid'), `${process.pid}\n`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const stat = statSync(lock);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          rmrf(lock);
          continue;
        }
      } catch {
        // The lock disappeared between mkdir and stat; retry immediately.
        continue;
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new DsvmError('another dsvm process holds the state lock; try again in a moment');
      }
      await sleep(150);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function currentVersion(config: Config = readConfig()): string | null {
  return config.current?.version ?? null;
}

export function describeCurrent(config: Config = readConfig()): string {
  if (!config.current) return 'none';
  const { version, kind, spec } = config.current;
  return kind === 'tag' ? `${version} (${spec})` : `${version} (pinned)`;
}
