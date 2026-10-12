import { clearNwCache, ensureNwjs, fetchLatestNwVersion, readCachedVersion } from './nwjs.js';
import { launchDesktop } from './launch.js';
import { installShortcut, uninstallShortcut } from './shortcut.js';
import { fail, info } from '../util.js';

export function desktopHelpText(): string {
  return [
    'Run dsh web UI in a bundled NW.js desktop app (always the SDK variant).',
    '',
    'The app embeds the URL reported by `dsvm service url`, so the service',
    'must be installed and running first (`dsvm service install` + `enable`).',
    'Options starting with `-` are passed through to nw.js, so Chromium',
    'switches work directly, e.g. `--ozone-platform=x11` to use XWayland',
    '(the bundled hint auto-selects native Wayland; an explicit switch wins).',
    'Shortcuts launch the cached nw.js binary directly, never through dsvm,',
    'through a stable path that survives updates.',
    '',
    'Subcommands:',
    '  (none) [--nw-switch...] Ensure the nw.js SDK cache and launch the app,',
    '                           passing switches through to nw.js',
    '  install [--nw-switch...] Cache nw.js SDK and create a user shortcut',
    '                           (Linux .desktop entry, Windows Start Menu + Desktop,',
    '                           macOS app bundle in ~/Applications); switches',
    '                           are baked into the shortcut',
    '  uninstall            Remove the shortcut and delete the nw.js cache',
    '  update               Install the newest nw.js SDK when one is available',
  ].join('\n');
}

const SUBCOMMANDS = new Set(['install', 'uninstall', 'update', 'help', '--help', '-h']);

export async function desktopCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  // `--` 开关透传给 nw（`dsvm desktop --ozone-platform=x`）；
  // 裸词非子命令视为拼写错误，避免 typo 触发下载和启动。
  if (subcommand !== undefined && !SUBCOMMANDS.has(subcommand)) {
    if (!subcommand.startsWith('-')) {
      fail(`unknown desktop subcommand "${subcommand}"\n\n${desktopHelpText()}`);
    }
    return launchDesktop(args);
  }
  switch (subcommand) {
    case undefined:
      return launchDesktop([]);
    case 'install': {
      const { version, binary } = await ensureNwjs();
      const result = await installShortcut(binary, undefined, rest);
      info(`cached nw.js SDK ${version}`);
      for (const created of result.created) info(`created ${created}`);
      for (const removed of result.removed) info(`removed legacy ${removed}`);
      for (const note of result.notes) info(`note: ${note}`);
      info('launch it from your application menu, or run `dsvm desktop`');
      return;
    }
    case 'uninstall':
    case 'update': {
      if (rest.length > 0) fail(`usage: dsvm desktop ${subcommand}`);
      if (subcommand === 'uninstall') {
        const result = await uninstallShortcut();
        clearNwCache();
        if (result.removed.length === 0) {
          info('no dsvm desktop shortcut found');
        } else {
          for (const removed of result.removed) info(`removed ${removed}`);
        }
        info('deleted the cached nw.js SDK');
        return;
      }
      const latest = await fetchLatestNwVersion();
      const cached = readCachedVersion();
      if (cached === latest) {
        // 二进制可能被用户删过，补齐但不算更新。
        await ensureNwjs();
        info(`nw.js SDK is already the newest (${latest})`);
        return;
      }
      await ensureNwjs({ update: true });
      info(`updated nw.js SDK ${cached ?? '(none)'} -> ${latest}`);
      return;
    }
    case 'help':
    case '--help':
    case '-h':
      if (rest.length > 0) fail('usage: dsvm desktop help');
      info(desktopHelpText());
      return;
    default:
      fail(`unknown desktop subcommand "${subcommand}"\n\n${desktopHelpText()}`);
  }
}
