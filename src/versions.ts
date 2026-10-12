import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig, updateConfig, withLock } from './config.js';
import type { Config, CurrentSelection } from './config.js';
import { dshBin, versionDir, versionsDir } from './paths.js';
import { PACKAGE_NAME, registryUrl, resolveSpec } from './registry.js';
import type { ResolvedSpec } from './registry.js';
import { isServiceRunning } from './service/index.js';
import {
  DsvmError,
  dim,
  fail,
  info,
  npmCommand,
  runInherit,
  rmrf,
  warn,
  writeJsonAtomic,
} from './util.js';

export function isInstalled(version: string): boolean {
  return existsSync(dshBin(version));
}

function parseVersion(version: string): { numbers: number[]; pre: string } {
  const clean = version.split('+')[0] ?? version;
  const dash = clean.indexOf('-');
  const core = dash === -1 ? clean : clean.slice(0, dash);
  const pre = dash === -1 ? '' : clean.slice(dash + 1);
  return { numbers: core.split('.').map((part) => Number(part) || 0), pre };
}

/** Semver-ish comparison good enough for ordering dsh versions. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.numbers[i] ?? 0) - (right.numbers[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (!left.pre && !right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  const leftParts = left.pre.split('.');
  const rightParts = right.pre.split('.');
  for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i += 1) {
    const x = leftParts[i];
    const y = rightParts[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff;
    } else if (xNumeric) {
      return -1;
    } else if (yNumeric) {
      return 1;
    } else {
      const diff = x.localeCompare(y);
      if (diff !== 0) return diff;
    }
  }
  return 0;
}

export interface ListState {
  current: CurrentSelection | null;
  installed: string[];
  tags: Record<string, string>;
  config: Config;
}

export function listState(): ListState {
  const config = readConfig();
  const installed = new Set(Object.keys(config.installed).filter(isInstalled));
  try {
    for (const entry of readdirSync(versionsDir(), { withFileTypes: true })) {
      if (entry.isDirectory() && isInstalled(entry.name)) installed.add(entry.name);
    }
  } catch {
    // No versions directory yet.
  }
  return {
    current: config.current,
    installed: [...installed].sort(compareVersions),
    tags: config.tags,
    config,
  };
}

/**
 * Install one concrete version into ~/.dsvm/versions/<version>.
 * `tag` records which dist-tag the version came from.
 */
/**
 * Record a version (and optionally its dist-tag) in the config. Tags are
 * independent pointers: recording `next` never touches `latest`, even when
 * both currently resolve to the same version.
 */
function recordVersion(version: string, tag: string | null): void {
  updateConfig((config) => {
    const existing = config.installed[version];
    config.installed[version] = {
      installedAt: existing?.installedAt ?? new Date().toISOString(),
      tag: existing?.tag ?? tag ?? null,
    };
    if (tag) config.tags[tag] = version;
  });
}

/**
 * Install one concrete version into ~/.dsvm/versions/<version>.
 * `tag` records which dist-tag the version came from.
 */
export async function installVersion(
  version: string,
  { tag = null, force = false }: { tag?: string | null; force?: boolean } = {},
): Promise<{ installed: boolean }> {
  if (isInstalled(version) && !force) {
    // Already on disk; still record the tag mapping and install metadata so
    // `dsvm install <tag>` works for a version another tag installed first.
    recordVersion(version, tag);
    return { installed: false };
  }
  const dir = versionDir(version);
  if (force) rmrf(dir);
  writeJsonAtomic(join(dir, 'package.json'), {
    name: `dsvm-dsh-${version.replace(/[^0-9A-Za-z.-]/g, '_')}`,
    version: '0.0.0',
    private: true,
    description: `dsvm-managed installation of ${PACKAGE_NAME}@${version}`,
  });

  const npm = npmCommand();
  const args = [
    ...npm.prefixArgs,
    'install',
    '--prefix',
    dir,
    '--no-save',
    '--no-package-lock',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    '--registry',
    registryUrl(),
    `${PACKAGE_NAME}@${version}`,
  ];
  const code = await runInherit(npm.command, args, { shell: npm.shell });
  if (code !== 0 || !isInstalled(version)) {
    rmrf(dir);
    throw new DsvmError(`failed to install ${PACKAGE_NAME}@${version} (npm exited with code ${code})`);
  }
  recordVersion(version, tag);
  return { installed: true };
}

function sourceNote(resolved: ResolvedSpec): void {
  if (resolved.source === 'offline') {
    warn(`npm registry unavailable; using cached dist-tag mapping for "${resolved.tag}"`);
  }
}

const PINNED_HINT =
  'the active version is pinned. Pass a dist-tag (e.g. `dsvm update latest`), or switch to a tag first with `dsvm use latest`';

export async function installCommand(
  spec: string | undefined,
  { force = false }: { force?: boolean } = {},
): Promise<ResolvedSpec> {
  return withLock(async () => {
    const resolved = await resolveSpec(spec ?? 'latest', { refresh: true });
    sourceNote(resolved);
    const { installed } = await installVersion(resolved.version, { tag: resolved.tag, force });
    const label = resolved.tag ? ` (${resolved.tag})` : '';
    info(
      installed
        ? `installed dsh ${resolved.version}${label}`
        : `dsh ${resolved.version}${label} is already installed`,
    );

    const config = readConfig();
    let switched = false;
    if (!config.current) {
      updateConfig((next) => {
        next.current = {
          kind: resolved.tag ? 'tag' : 'version',
          spec: resolved.tag ?? resolved.version,
          version: resolved.version,
        };
      });
      switched = true;
    } else if (
      resolved.tag &&
      config.current.kind === 'tag' &&
      config.current.spec === resolved.tag &&
      config.current.version !== resolved.version
    ) {
      updateConfig((next) => {
        if (next.current) next.current.version = resolved.version;
      });
      switched = true;
    }
    if (switched) {
      info(`now using dsh ${resolved.version}${label}`);
      await hintServiceRestart();
    }
    return resolved;
  });
}

export async function useCommand(spec: string): Promise<ResolvedSpec> {
  if (!spec) fail('usage: dsvm use <version|tag>');
  return withLock(async () => {
    const resolved = await resolveSpec(spec);
    sourceNote(resolved);
    const before = readConfig();
    if (!isInstalled(resolved.version)) {
      info(`dsh ${resolved.version} is not installed; installing...`);
      await installVersion(resolved.version, { tag: resolved.tag });
    } else if (resolved.tag) {
      updateConfig((config) => {
        config.tags[resolved.tag as string] = resolved.version;
      });
    }
    const kind: CurrentSelection['kind'] = resolved.tag ? 'tag' : 'version';
    const previous = before.current;
    updateConfig((config) => {
      config.current = { kind, spec: resolved.tag ?? resolved.version, version: resolved.version };
    });
    const changed =
      previous?.version !== resolved.version ||
      previous?.kind !== kind ||
      previous?.spec !== (resolved.tag ?? resolved.version);
    const label = resolved.tag ? ` (${resolved.tag})` : '';
    if (changed) info(`now using dsh ${resolved.version}${label}`);
    else info(`already using dsh ${resolved.version}${label}`);
    if (changed) await hintServiceRestart();
    return resolved;
  });
}

export async function updateCommand(requestedTag?: string): Promise<ResolvedSpec> {
  return withLock(async () => {
    let tag = requestedTag;
    const before = readConfig();
    if (!tag) {
      if (!before.current) fail('no active dsh version; run `dsvm install` first');
      if (before.current.kind !== 'tag') {
        fail(`current version ${before.current.version} is pinned; ${PINNED_HINT}`);
      }
      tag = before.current.spec;
    }
    const resolved = await resolveSpec(tag, { refresh: true, allowOfflineCache: false });
    if (!resolved.tag) fail(`\`dsvm update\` expects a dist-tag, but "${tag}" is not one`);
    const previousVersion = before.tags[tag] ?? null;
    const { installed } = await installVersion(resolved.version, { tag: resolved.tag });
    let switched = false;
    const fresh = readConfig();
    if (
      fresh.current?.kind === 'tag' &&
      fresh.current.spec === tag &&
      fresh.current.version !== resolved.version
    ) {
      updateConfig((config) => {
        if (config.current) config.current.version = resolved.version;
      });
      switched = true;
    }
    if (switched || installed) {
      info(`updated ${tag}: ${previousVersion ?? 'unknown'} -> ${resolved.version}`);
    } else {
      info(`dsh ${resolved.version} (${tag}) is already up to date`);
    }
    if (switched) {
      info(`now using dsh ${resolved.version} (${tag})`);
      await hintServiceRestart();
    }
    return resolved;
  });
}

export async function uninstallCommand(target: string): Promise<void> {
  if (!target) fail('usage: dsvm uninstall <version|tag>');
  await withLock(async () => {
    const resolved = await resolveSpec(target);
    const { version } = resolved;
    const config = readConfig();
    if (config.current?.version === version) {
      fail(`cannot uninstall the active version ${version}; switch to another version first`);
    }
    if (!config.installed[version] && !existsSync(versionDir(version))) {
      fail(`dsh ${version} is not installed`);
    }
    rmrf(versionDir(version));
    updateConfig((next) => {
      delete next.installed[version];
      for (const [tag, mapped] of Object.entries(next.tags)) {
        if (mapped === version) {
          delete next.tags[tag];
          warn(`dist-tag ${tag} mapped to the removed version; mapping cleared`);
        }
      }
    });
    info(`uninstalled dsh ${version}`);
  });
}

export interface ActiveDsh {
  version: string;
  bin: string;
  config: Config;
}

/** Resolve the active version and its dsh entry script. */
export function activeDsh(): ActiveDsh {
  const config = readConfig();
  if (!config.current) fail('no active dsh version; run `dsvm install` first');
  const { version } = config.current;
  const bin = dshBin(version);
  if (!existsSync(bin)) {
    fail(
      `active dsh version ${version} is missing from ${versionDir(version)}; reinstall it with \`dsvm install ${version}\``,
    );
  }
  return { version, bin, config };
}

export async function hintServiceRestart(): Promise<void> {
  let running = false;
  try {
    running = await isServiceRunning();
  } catch {
    running = false;
  }
  if (running) {
    info(dim('dsvm service is running; run `dsvm service restart` to apply the new version'));
  }
}
