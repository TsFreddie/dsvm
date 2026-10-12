import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { expandTilde } from './util.js';

export function dsvmHome(): string {
  const configured = process.env.DSVM_HOME;
  if (configured) return resolve(expandTilde(configured));
  return join(homedir(), '.dsvm');
}

export function versionsDir(): string {
  return join(dsvmHome(), 'versions');
}

export function versionDir(version: string): string {
  return join(versionsDir(), version);
}

export function dshPackageDir(version: string): string {
  return join(versionDir(version), 'node_modules', '@deepseek-ai', 'dsh');
}

export function dshBin(version: string): string {
  return join(dshPackageDir(version), 'lib', 'bin.js');
}

export function dshManifest(version: string): string {
  return join(dshPackageDir(version), 'package.json');
}

export function configFile(): string {
  return join(dsvmHome(), 'config.json');
}

export function lockFile(): string {
  return join(dsvmHome(), '.lock');
}

export function cacheDir(): string {
  return join(dsvmHome(), 'cache');
}

export function packumentCacheFile(): string {
  return join(cacheDir(), 'packument.json');
}

export function serviceDir(): string {
  return join(dsvmHome(), 'service');
}

export function serviceConfigFile(): string {
  return join(serviceDir(), 'service.json');
}

export function serviceUrlFile(): string {
  return join(serviceDir(), 'url.json');
}

export function serviceLogsDir(): string {
  return join(serviceDir(), 'logs');
}

/** Absolute path of the dsvm entry script, following npm-link symlinks. */
export function dsvmBinPath(): string {
  // src/paths.ts -> ../bin, build/src/paths.ts -> ../../bin.
  const candidates = [
    new URL('../../bin/dsvm.js', import.meta.url),
    new URL('../bin/dsvm.js', import.meta.url),
  ];
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate);
    try {
      return realpathSync(path);
    } catch {
      // Try the next layout.
    }
  }
  return fileURLToPath(candidates[0] as URL);
}

/** Directory that holds the dsvm checkout/installation (used for diagnostics). */
export function dsvmRootDir(): string {
  return dirname(dsvmBinPath());
}
