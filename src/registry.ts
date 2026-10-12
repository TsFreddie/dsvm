import { packumentCacheFile } from './paths.js';
import { readConfig } from './config.js';
import {
  DsvmError,
  npmCommand,
  readJson,
  run,
  writeJsonAtomic,
} from './util.js';

export const PACKAGE_NAME = '@deepseek-ai/dsh';

const CACHE_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export type ResolveSource = 'exact' | 'registry' | 'cache' | 'offline' | 'npm';

export interface Packument {
  distTags: Record<string, string>;
  versions: string[];
  source: 'registry' | 'cache' | 'offline';
}

export interface ResolvedSpec {
  version: string;
  tag: string | null;
  source: ResolveSource;
}

interface CacheFile {
  registry?: string;
  fetchedAt?: string;
  doc?: { distTags?: Record<string, string>; versions?: string[] };
}

export function isExactVersion(spec: string): boolean {
  return EXACT_VERSION_RE.test(spec);
}

export function registryUrl(): string {
  const configured =
    process.env.DSVM_REGISTRY ??
    process.env.npm_config_registry ??
    process.env.NPM_CONFIG_REGISTRY;
  const base = configured && configured.trim() !== '' ? configured.trim() : 'https://registry.npmjs.org';
  return base.replace(/\/+$/, '');
}

/** Fetch dist-tags and the version list, with a small on-disk cache. */
export async function fetchPackument({ force = false } = {}): Promise<Packument> {
  const registry = registryUrl();
  const cached = readJson<CacheFile | null>(packumentCacheFile(), null);
  const cachedUsable =
    cached !== null &&
    cached.registry === registry &&
    typeof cached.doc === 'object' &&
    cached.doc !== null;
  const fresh =
    cachedUsable &&
    typeof cached.fetchedAt === 'string' &&
    Date.now() - Date.parse(cached.fetchedAt) < CACHE_TTL_MS;
  if (!force && fresh && cached.doc) {
    return { distTags: cached.doc.distTags ?? {}, versions: cached.doc.versions ?? [], source: 'cache' };
  }

  try {
    const response = await fetch(`${registry}/${encodeURIComponent(PACKAGE_NAME)}`, {
      headers: { Accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const body = (await response.json()) as { 'dist-tags'?: Record<string, string>; versions?: Record<string, unknown> };
    const doc = {
      distTags: body['dist-tags'] ?? {},
      versions: Object.keys(body.versions ?? {}),
    };
    writeJsonAtomic(packumentCacheFile(), {
      registry,
      fetchedAt: new Date().toISOString(),
      doc,
    });
    return { ...doc, source: 'registry' };
  } catch (error) {
    if (cachedUsable && cached.doc) {
      return { distTags: cached.doc.distTags ?? {}, versions: cached.doc.versions ?? [], source: 'offline' };
    }
    throw new DsvmError(
      `cannot fetch ${PACKAGE_NAME} metadata from ${registry}: ${(error as Error).message}`,
    );
  }
}

/** Pure helper: map a dist-tag to a version. */
export function resolveFromPackument(
  packument: Pick<Packument, 'distTags'>,
  spec: string,
): { version: string; tag: string } | null {
  const version = packument.distTags[spec];
  if (typeof version === 'string' && version !== '') return { version, tag: spec };
  return null;
}

async function resolveWithNpm(spec: string): Promise<ResolvedSpec> {
  const npm = npmCommand();
  const args = [
    ...npm.prefixArgs,
    'view',
    `${PACKAGE_NAME}@${spec}`,
    'version',
    '--json',
    '--registry',
    registryUrl(),
  ];
  const result = await run(npm.command, args, { allowFailure: true, shell: npm.shell });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split('\n').pop() ?? '';
    throw new DsvmError(`unknown dsh version or dist-tag "${spec}"${detail ? ` (${detail})` : ''}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new DsvmError(`could not parse npm output while resolving "${spec}"`);
  }
  const versions = (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (entry): entry is string => typeof entry === 'string',
  );
  const version = versions.pop();
  if (!version) throw new DsvmError(`unknown dsh version or dist-tag "${spec}"`);
  return { version, tag: null, source: 'npm' };
}

/**
 * Resolve a user-supplied spec (exact version, dist-tag, or any range npm
 * understands) to a concrete version.
 */
export async function resolveSpec(
  spec: string | undefined,
  { refresh = false, allowOfflineCache = true } = {},
): Promise<ResolvedSpec> {
  const requested = spec && spec.trim() !== '' ? spec.trim() : 'latest';
  if (isExactVersion(requested)) return { version: requested, tag: null, source: 'exact' };

  let packument: Packument;
  try {
    packument = await fetchPackument({ force: refresh });
  } catch (error) {
    if (allowOfflineCache) {
      const known = cachedTag(readConfig().tags, requested);
      if (known) return { version: known, tag: requested, source: 'offline' };
    }
    throw error;
  }
  const resolved = resolveFromPackument(packument, requested);
  if (resolved) {
    if (packument.source === 'offline' && !allowOfflineCache) {
      throw new DsvmError(
        `cannot reach the npm registry to resolve dist-tag "${requested}"; try again when online`,
      );
    }
    return { ...resolved, source: packument.source };
  }

  // Not a known tag. Ranges and other spec forms are delegated to npm, which
  // caches metadata itself and is the authority on comparisons.
  return resolveWithNpm(requested);
}

/** Last-known tag mapping stored in ~/.dsvm/config.json, used as an offline fallback. */
export function cachedTag(tags: Record<string, string>, tag: string): string | null {
  const version = tags[tag];
  return typeof version === 'string' && version !== '' ? version : null;
}
