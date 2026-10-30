import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { readConfig, updateConfig, withLock } from './config.js';
import type { LinkConfig } from './config.js';
import { dshBin, versionsDir } from './paths.js';
import {
  DsvmError,
  fail,
  info,
  isWindows,
  mkdirp,
  warn,
  writeTextAtomic,
} from './util.js';

export type LinkKind = LinkConfig['kind'];

const WINDOWS_EXTENSIONS = (): string[] => {
  const pathext = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  return pathext
    .split(';')
    .map((extension) => extension.trim())
    .filter((extension) => extension !== '');
};

const BATCH_MARKER = 'rem managed by dsvm; this file is updated automatically';

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function samePath(a: string, b: string): boolean {
  const normalize = (path: string): string => {
    const resolved = resolve(path);
    return isWindows ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}

function isManagedTarget(target: string): boolean {
  const rel = relative(versionsDir(), resolve(target));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** The `dsh` path that lives next to a dsvm command. */
export function linkPathFor(dsvmCommandPath: string): string {
  return join(dirname(dsvmCommandPath), isWindows ? 'dsh.cmd' : 'dsh');
}

function invokedDsvmPath(): string | null {
  if (isWindows) return null; // npm's shim runs the package script, not the PATH entry.
  const script = process.argv[1];
  if (!script) return null;
  return basename(script) === 'dsvm' ? resolve(script) : null;
}

/** Find the dsvm command on PATH, mirroring the order a shell would use. */
export function findDsvmCommand(): string | null {
  const pathValue = process.env.PATH ?? '';
  const extensions = isWindows ? WINDOWS_EXTENSIONS() : [''];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = resolve(dir, `dsvm${extension}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The dsvm executable whose directory receives the `dsh` link. Prefer the
 * actually invoked `dsvm` (important when several installs exist), then the
 * first one on PATH.
 */
export function locateDsvmCommand(): string | null {
  return invokedDsvmPath() ?? findDsvmCommand();
}

function renderBatchLink(target: string): string {
  const lines = [
    '@echo off',
    BATCH_MARKER,
    // Use node from PATH, matching the Unix symlink shebang (`#!/usr/bin/env node`)
    // so switching Node installations keeps the link usable.
    `node "${target.replace(/%/g, '%%')}" %*`,
    '',
  ];
  return lines.join('\r\n');
}

function createSymlink(path: string, target: string): void {
  mkdirp(dirname(path));
  try {
    symlinkSync(target, path);
  } catch (error) {
    throw new DsvmError(
      `could not create ${path}: ${(error as Error).message}; check permissions (a global dsvm may need elevated rights)`,
      { cause: error },
    );
  }
}

function replaceWithSymlink(path: string, target: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isMissing(error)) {
      throw new DsvmError(`could not replace ${path}: ${(error as Error).message}`, { cause: error });
    }
  }
  createSymlink(path, target);
}

function writeSymlink(path: string, target: string, force: boolean): 'created' | 'updated' | 'unchanged' {
  let existing;
  try {
    existing = lstatSync(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    createSymlink(path, target);
    return 'created';
  }
  if (existing.isDirectory()) {
    fail(`${path} is a directory; cannot link dsh there`);
  }
  if (existing.isSymbolicLink()) {
    const current = resolve(dirname(path), readlinkSync(path));
    if (samePath(current, target)) return 'unchanged';
    if (!force && !isManagedTarget(current)) {
      fail(
        `refusing to replace ${path}: it is a symlink to ${current}; use \`dsvm link --force\` to replace it`,
      );
    }
    replaceWithSymlink(path, target);
    return 'updated';
  }
  if (!force) {
    fail(
      `refusing to replace ${path}: it is an existing file; use \`dsvm link --force\` to replace it`,
    );
  }
  replaceWithSymlink(path, target);
  return 'updated';
}

function writeBatch(path: string, target: string, force: boolean): 'created' | 'updated' | 'unchanged' {
  const rendered = renderBatchLink(target);
  let existing;
  try {
    existing = lstatSync(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    writeTextAtomic(path, rendered, 0o755);
    return 'created';
  }
  if (existing.isDirectory()) {
    fail(`${path} is a directory; cannot link dsh there`);
  }
  if (!existing.isSymbolicLink() && !existing.isFile()) {
    fail(`${path} is not a regular file; cannot link dsh there`);
  }
  let managed = false;
  if (existing.isFile()) {
    try {
      managed = readFileSync(path, 'utf8').includes(BATCH_MARKER);
    } catch {
      managed = false;
    }
  }
  if (!force && !managed) {
    fail(
      `refusing to replace ${path}: it already exists and was not created by dsvm; use \`dsvm link --force\` to replace it`,
    );
  }
  if (existing.isFile() && readFileSync(path, 'utf8') === rendered) return 'unchanged';
  writeTextAtomic(path, rendered, 0o755);
  return 'updated';
}

export function writeLink(
  path: string,
  target: string,
  { kind, force = false }: { kind: LinkKind; force?: boolean },
): 'created' | 'updated' | 'unchanged' {
  if (!existsSync(target)) fail(`dsh entry script does not exist: ${target}`);
  return kind === 'cmd' ? writeBatch(path, target, force) : writeSymlink(path, target, force);
}

function parseLinkArgs(args: readonly string[]): { force: boolean } {
  let force = false;
  for (const arg of args) {
    if (arg === '--force' || arg === '-f') {
      force = true;
    } else if (arg === '--help' || arg === '-h') {
      fail('usage: dsvm link [--force]');
    } else {
      fail(`unknown argument "${arg}" for \`dsvm link\`\nusage: dsvm link [--force]`);
    }
  }
  return { force };
}

export interface LinkTarget {
  version: string;
  bin: string;
}

/**
 * Re-point the configured `dsh` link at `version`. Called after dsvm switches
 * or updates the active version; a link the user removed is forgotten rather
 * than silently recreated.
 */
export function syncLinkIfConfigured(): void {
  const config = readConfig();
  const link = config.link;
  if (!link) return;
  if (!config.current) return;

  try {
    lstatSync(link.path);
  } catch (error) {
    if (isMissing(error)) {
      updateConfig((next) => {
        delete next.link;
      });
      return;
    }
    warn(`could not inspect the dsh link ${link.path}: ${(error as Error).message}`);
    return;
  }

  const target = dshBin(config.current.version);
  try {
    const result = writeLink(link.path, target, { kind: link.kind });
    if (result !== 'unchanged') info(`updated dsh link: ${link.path} -> ${target}`);
  } catch (error) {
    warn(`could not update the dsh link ${link.path}: ${(error as Error).message}`);
  }
}

/**
 * `dsvm link` — create `dsh` next to the dsvm command that is in PATH.
 * The link points directly at the active version's dsh entry script and is
 * re-pointed whenever dsvm switches or updates the active version.
 */
export async function linkCommand(args: readonly string[], dsh: LinkTarget): Promise<void> {
  const { force } = parseLinkArgs(args);
  await withLock(async () => {
    const dsvm = locateDsvmCommand();
    if (!dsvm) {
      fail(
        'could not find the dsvm command in PATH; install dsvm globally or add its directory to PATH, then run `dsvm link` again',
      );
    }
    const kind: LinkKind = isWindows ? 'cmd' : 'symlink';
    const path = linkPathFor(dsvm);
    const result = writeLink(path, dsh.bin, { kind, force });
    updateConfig((config) => {
      config.link = { path, kind };
    });
    info(
      `${result === 'unchanged' ? 'already linked' : 'linked'}: ${path} -> ${dsh.bin} (dsh ${dsh.version})`,
    );
  });
}
