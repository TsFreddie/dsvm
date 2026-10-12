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
    'Shortcuts launch the cached nw.js binary directly, never through dsvm.',
    '',
    'Subcommands:',
    '  (none)               Ensure the nw.js SDK cache and launch the app',
    '  install              Cache nw.js SDK and create a user shortcut',
    '                       (Linux .desktop entry, Windows Start Menu + Desktop,',
    '                       macOS app bundle in ~/Applications)',
    '  uninstall            Remove the shortcut and delete the nw.js cache',
    '  update               Install the newest nw.js SDK when one is available',
  ].join('\n');
}

export async function desktopCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (rest.length > 0) fail(`usage: dsvm desktop [install|uninstall|update]`);
  switch (subcommand) {
    case undefined:
      return launchDesktop();
    case 'install': {
      const { version, binary } = await ensureNwjs();
      const result = await installShortcut(binary);
      info(`cached nw.js SDK ${version}`);
      for (const created of result.created) info(`created ${created}`);
      for (const note of result.notes) info(`note: ${note}`);
      info('launch it from your application menu, or run `dsvm desktop`');
      return;
    }
    case 'uninstall': {
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
    case 'update': {
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
      info(desktopHelpText());
      return;
    default:
      fail(`unknown desktop subcommand "${subcommand}"\n\n${desktopHelpText()}`);
  }
}
