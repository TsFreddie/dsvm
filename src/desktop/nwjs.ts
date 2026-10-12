import {
  cpSync,
  createWriteStream,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirp, rmrf, run } from '../util.js';
import { DsvmError, fail } from '../util.js';
import { dsvmHome } from '../paths.js';

export const NW_VERSIONS_URL = 'https://nwjs.io/versions.json';
export const NW_DOWNLOAD_BASE = 'https://dl.nwjs.io';
/** dsvm 只用 SDK variant（带 devtools，便于调试 dsh 前端）。 */
export const NW_FLAVOR = 'sdk';

/** Directory that holds the nw.js cache: `<DSVM_HOME>/desktop/nwjs/`. */
export function nwCacheRoot(): string {
  return join(dsvmHome(), 'desktop', 'nwjs');
}

export function nwVersionFile(): string {
  return join(nwCacheRoot(), 'version.json');
}

export function readCachedVersion(): string | null {
  if (!existsSync(nwVersionFile())) return null;
  try {
    const parsed = JSON.parse(readFileSync(nwVersionFile(), 'utf8')) as {
      version?: unknown;
    };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

export interface NwAsset {
  /** versions.json / dl.nwjs.io 中的平台标识，如 `linux-x64`。 */
  asset: string;
  /** `tar.gz`（Linux）或 `zip`（Windows/macOS）。 */
  ext: 'tar.gz' | 'zip';
  /** 解包目录下可执行文件的相对路径。 */
  binary: string;
  /** dl.nwjs.io 上的压缩包文件名（不含版本前缀外的其它成分）。 */
  file: (version: string) => string;
}

/**
 * 解析当前平台的 nw.js 产物形态。永远返回 SDK variant。
 * 纯函数，便于单测。
 */
export function nwAssetFor(platform: NodeJS.Platform, arch: string): NwAsset {
  const flavor = NW_FLAVOR;
  if (platform === 'linux') {
    if (arch === 'x64' || arch === 'arm64') {
      const asset = `linux-${arch}`;
      return {
        asset,
        ext: 'tar.gz',
        binary: join(`nwjs-${flavor}-VERSION-${asset}`, 'nw'),
        file: (version) => `nwjs-${flavor}-${version}-${asset}.tar.gz`,
      };
    }
  } else if (platform === 'win32') {
    const winArch = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : arch === 'ia32' ? 'ia32' : null;
    if (winArch) {
      const asset = `win-${winArch}`;
      return {
        asset,
        ext: 'zip',
        binary: join(`nwjs-${flavor}-VERSION-${asset}`, 'nw.exe'),
        file: (version) => `nwjs-${flavor}-${version}-${asset}.zip`,
      };
    }
  } else if (platform === 'darwin') {
    if (arch === 'x64' || arch === 'arm64') {
      const asset = `osx-${arch}`;
      return {
        asset,
        ext: 'zip',
        binary: join(
          `nwjs-${flavor}-VERSION-${asset}`,
          'nwjs.app',
          'Contents',
          'MacOS',
          'nwjs',
        ),
        file: (version) => `nwjs-${flavor}-${version}-${asset}.zip`,
      };
    }
  }
  fail(
    `dsvm desktop does not support platform "${platform}/${arch}" ` +
      `(supported: linux x64/arm64, Windows x64/arm64/ia32, macOS x64/arm64)`,
  );
}

export function nwAsset(): NwAsset {
  return nwAssetFor(process.platform, process.arch);
}

/** Directory of the built-in nw.js app shipped with dsvm (`desktop/`). */
export function desktopAppDir(): string {
  // src/desktop/nwjs.ts -> ../../desktop, build/src/desktop/nwjs.js -> ../../../desktop.
  const candidates = [
    new URL('../../desktop/package.json', import.meta.url),
    new URL('../../../desktop/package.json', import.meta.url),
  ];
  for (const candidate of candidates) {
    try {
      const manifest = fileURLToPath(candidate);
      if (existsSync(manifest)) return dirname(manifest);
    } catch {
      // Try the next layout.
    }
  }
  throw new DsvmError('cannot locate the built-in dsvm desktop app (desktop/package.json)');
}

export function nwInstallDir(version: string): string {
  return join(nwCacheRoot(), version);
}

/** 可执行文件绝对路径（binary 模板中的 VERSION 占位替换为实际版本）。 */
export function nwBinaryFor(version: string, asset: NwAsset = nwAsset()): string {
  return join(nwInstallDir(version), asset.binary.replace('VERSION', version));
}

interface VersionsJson {
  stable?: unknown;
  latest?: unknown;
}

export async function fetchLatestNwVersion(
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchFn(NW_VERSIONS_URL);
  } catch (error) {
    throw new DsvmError(
      `cannot reach ${NW_VERSIONS_URL}: ${(error as Error).message}`,
    );
  }
  if (!response.ok) {
    throw new DsvmError(`${NW_VERSIONS_URL} returned HTTP ${response.status}`);
  }
  const parsed = (await response.json()) as VersionsJson;
  const version =
    typeof parsed.stable === 'string'
      ? parsed.stable
      : typeof parsed.latest === 'string'
        ? parsed.latest
        : null;
  if (!version || !/^v\d+\.\d+\.\d+/.test(version)) {
    throw new DsvmError(`cannot parse an nw.js version from ${NW_VERSIONS_URL}`);
  }
  return version;
}

function downloadUrl(version: string, asset: NwAsset): string {
  return `${NW_DOWNLOAD_BASE}/${version}/${asset.file(version)}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = value >= 100 ? `${Math.round(value)}` : value.toFixed(1);
  return `${text} ${units[unit]}`;
}

/** 纯函数：渲染一行进度条文本，便于单测。total 为 null 表示未知总长。 */
export function renderProgressBar(
  done: number,
  total: number | null,
  width = 24,
): string {
  if (total === null || !Number.isFinite(total) || total <= 0) {
    return `[${'.'.repeat(width)}]`;
  }
  const ratio = Math.min(1, Math.max(0, done / total));
  const filled = Math.round(ratio * width);
  return `[${'='.repeat(filled)}${'-'.repeat(width - filled)}]`;
}

export interface ProgressSink {
  write: (text: string) => void;
  isTTY: boolean;
}

/**
 * 下载进度条：TTY 走 stderr 同行刷新，非 TTY 每 10% 打一行。
 * 写 stderr，保证 stdout 只留给最终结果。
 */
export class DownloadProgress {
  private done = 0;
  private readonly startedAt: number;
  private lastPaint = 0;
  private lastLoggedStep = -1;
  private finished = false;

  constructor(
    private readonly label: string,
    private readonly total: number | null,
    private readonly sink: ProgressSink = process.stderr,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  update(received: number): void {
    if (this.finished) return;
    this.done += received;
    const elapsed = Math.max(1, this.now() - this.startedAt);
    const speed = `${formatBytes((this.done * 1000) / elapsed)}/s`;
    if (this.sink.isTTY) {
      // 节流：最多约 8 次/秒，避免闪烁和刷屏。
      if (this.now() - this.lastPaint < 120) return;
      this.lastPaint = this.now();
      const bar = renderProgressBar(this.done, this.total);
      const counter =
        this.total === null
          ? `${formatBytes(this.done)}`
          : `${Math.floor((this.done / this.total) * 100)}% ${formatBytes(this.done)}/${formatBytes(this.total)}`;
      this.sink.write(`\r${this.label} ${bar} ${counter} ${speed}   `);
      return;
    }
    if (this.total === null) return;
    const step = Math.floor((this.done / this.total) * 10);
    if (step <= this.lastLoggedStep) return;
    this.lastLoggedStep = step;
    this.sink.write(
      `${this.label}: ${step * 10}% (${formatBytes(this.done)}/${formatBytes(this.total)})\n`,
    );
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    const elapsed = ((this.now() - this.startedAt) / 1000).toFixed(1);
    if (this.sink.isTTY) {
      const bar = renderProgressBar(this.done, this.total);
      const counter =
        this.total === null
          ? `${formatBytes(this.done)}`
          : `100% ${formatBytes(this.done)}/${formatBytes(this.total)}`;
      this.sink.write(`\r${this.label} ${bar} ${counter} in ${elapsed}s\n`);
    } else {
      this.sink.write(`${this.label}: done (${formatBytes(this.done)} in ${elapsed}s)\n`);
    }
  }
}

async function downloadToFile(url: string, dest: string, label: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new DsvmError(`cannot download ${url}: ${(error as Error).message}`);
  }
  if (!response.ok || !response.body) {
    throw new DsvmError(`download failed: ${url} (HTTP ${response.status})`);
  }
  const totalRaw = Number(response.headers.get('content-length'));
  const total = Number.isFinite(totalRaw) && totalRaw > 0 ? totalRaw : null;
  const progress = new DownloadProgress(label, total);
  mkdirp(dirname(dest));
  const out = createWriteStream(dest);
  try {
    await response.body.pipeTo(
      new WritableStream({
        write: (chunk) =>
          new Promise<void>((resolve, reject) => {
            const bytes = chunk.byteLength;
            out.write(Buffer.from(chunk), (error) => {
              if (error) reject(error);
              else {
                progress.update(bytes);
                resolve();
              }
            });
          }),
        close: () =>
          new Promise<void>((resolve, reject) => {
            out.end((error?: Error) => (error ? reject(error) : resolve()));
          }),
        abort: (reason) => {
          out.destroy(reason instanceof Error ? reason : new Error(String(reason)));
        },
      }),
    );
    progress.finish();
  } finally {
    out.destroy();
  }
}

async function extractArchive(archive: string, destDir: string, ext: 'tar.gz' | 'zip'): Promise<void> {
  mkdirp(destDir);
  if (ext === 'tar.gz') {
    // tar 在 Linux/macOS 自带，Windows 10+ 自带 tar.exe。
    await run('tar', ['-xzf', archive, '-C', destDir]);
    return;
  }
  if (process.platform === 'win32') {
    // Windows 用 PowerShell 解 zip，不引入第三方依赖。
    await run('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath ${JSON.stringify(archive)} -DestinationPath ${JSON.stringify(destDir)} -Force`,
    ]);
    return;
  }
  // macOS/Linux 优先 unzip，否则用 ditto（macOS 自带）。
  try {
    await run('unzip', ['-q', '-o', archive, '-d', destDir]);
  } catch {
    if (process.platform === 'darwin') {
      await run('ditto', ['-x', '-k', archive, destDir]);
    } else {
      throw new DsvmError('cannot extract the nw.js archive: neither `unzip` nor a fallback is available');
    }
  }
}

/**
 * 下载并解包指定版本的 nw.js SDK 到缓存。幂等：目标目录已存在且二进制齐全则跳过。
 * 返回版本号。
 */
export async function installNwVersion(version: string): Promise<string> {
  const asset = nwAsset();
  const destDir = nwInstallDir(version);
  const binary = nwBinaryFor(version, asset);
  if (existsSync(binary)) return version;

  rmrf(`${destDir}.tmp`);
  const tmpDir = `${destDir}.tmp`;
  const archiveName = asset.file(version);
  const archivePath = join(tmpdir(), `dsvm-nwjs-${version}-${Date.now()}`, archiveName);
  try {
    mkdirp(tmpDir);
    await downloadToFile(downloadUrl(version, asset), archivePath, `downloading nw.js SDK ${version}`);
    await extractArchive(archivePath, tmpDir, asset.ext);
    if (!existsSync(join(tmpDir, asset.binary.replace('VERSION', version)))) {
      const entries = existsSync(tmpDir) ? readdirSync(tmpDir) : [];
      throw new DsvmError(
        `extracted nw.js ${version} but the binary is missing (top-level: ${entries.join(', ') || '(empty)'})`,
      );
    }
    // 原子替换：跨文件系统 rename 可能失败，失败则退回递归复制。
    try {
      rmrf(destDir);
      renameSync(tmpDir, destDir);
    } catch {
      rmrf(destDir);
      cpSync(tmpDir, destDir, { recursive: true });
      rmrf(tmpDir);
    }
  } finally {
    rmrf(tmpDir);
    try {
      rmSync(dirname(archivePath), { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
  mkdirp(nwCacheRoot());
  writeFileSync(nwVersionFile(), `${JSON.stringify({ version }, null, 2)}\n`);
  return version;
}

function pruneOldVersions(keep: string): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(nwCacheRoot(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('v'))
      .map((entry) => entry.name);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry !== keep) rmrf(join(nwCacheRoot(), entry));
  }
}

/**
 * 确保缓存中有可用的 nw.js SDK：
 * - 已有缓存：直接用（update 流程除外）；
 * - 没有缓存：自动下载最新版 SDK。
 * 返回 { version, binary }。
 */
export async function ensureNwjs(options: { update?: boolean } = {}): Promise<{
  version: string;
  binary: string;
}> {
  const asset = nwAsset();
  const cached = readCachedVersion();
  if (cached && !options.update && existsSync(nwBinaryFor(cached, asset))) {
    return { version: cached, binary: nwBinaryFor(cached, asset) };
  }
  const latest = await fetchLatestNwVersion();
  if (cached === latest && existsSync(nwBinaryFor(latest, asset))) {
    return { version: latest, binary: nwBinaryFor(latest, asset) };
  }
  await installNwVersion(latest);
  pruneOldVersions(latest);
  return { version: latest, binary: nwBinaryFor(latest, asset) };
}

/** 删除整个 nw.js 缓存（含 version.json）。 */
export function clearNwCache(): void {
  rmrf(nwCacheRoot());
}
