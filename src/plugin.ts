import { activeDsh } from './versions.js';
import { handoff } from './web.js';

export const DEFAULT_PLUGIN_PROFILE = 'web';

/**
 * Inject `--profile web` when the caller did not pick a profile.
 *
 * `dsh plugin` requires `--profile <name>`; dsvm serves the web UI, so
 * bare `dsvm plugin add <pkg>` targets the web profile. An explicit
 * `--profile` (or `--profile=<name>`) before an optional `--` separator is
 * respected. The default is prepended so commander still sees it as an
 * option rather than a pnpm operand.
 */
export function withDefaultProfile(args: readonly string[]): string[] {
  for (const arg of args) {
    if (arg === '--') break;
    if (arg === '--profile' || arg.startsWith('--profile=')) return [...args];
  }
  return ['--profile', DEFAULT_PLUGIN_PROFILE, ...args];
}

/**
 * `dsvm plugin` — manage the active version's plugins via `dsh plugin`.
 *
 * Passthrough with a default: every argument after `plugin` is forwarded to
 * `dsh plugin` of the active version, defaulting to `--profile web` when no
 * `--profile` was given (e.g. `dsvm plugin add <pkg>` manages the web
 * profile; `dsvm plugin --profile tui add <pkg>` manages tui). The process
 * is handed over to dsh just like `dsvm web` does outside service mode.
 */
export async function pluginCommand(args: string[]): Promise<void> {
  const { bin } = activeDsh();
  return handoff({ dshArgs: [bin, 'plugin', ...withDefaultProfile(args)] });
}
