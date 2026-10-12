import { readFileSync } from 'node:fs';
import { describeCurrent } from './config.js';
import { desktopCommand, desktopHelpText } from './desktop/index.js';
import { openCommand } from './open.js';
import { pluginCommand } from './plugin.js';
import { versionsDir } from './paths.js';
import { serviceCommand, serviceHelpText } from './service/index.js';
import { dim, fail, formatTimestamp, info } from './util.js';
import {
  installCommand,
  listState,
  uninstallCommand,
  updateCommand,
  useCommand,
} from './versions.js';
import { webCommand } from './web.js';

function readOwnVersion(): string {
  // Works from build/src/cli.js (published) and from src/cli.ts (direct run).
  for (const candidate of ['../../package.json', '../package.json']) {
    try {
      const parsed = JSON.parse(readFileSync(new URL(candidate, import.meta.url), 'utf8')) as { version?: string };
      if (typeof parsed.version === 'string') return parsed.version;
    } catch {
      // Try the next location.
    }
  }
  return '0.0.0';
}

const dsvmVersion = readOwnVersion();

interface ParseSpec {
  flags?: readonly string[];
  values?: readonly string[];
}

interface ParsedOptions {
  options: Record<string, string | boolean>;
  positional: string[];
}

function parseOptions(args: readonly string[], { flags = [], values = [] }: ParseSpec = {}): ParsedOptions {
  const options: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const flagSet = new Set(flags);
  const valueSet = new Set(values);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (flagSet.has(arg)) {
      options[arg.replace(/^--?/, '')] = true;
      continue;
    }
    const [name, inline] = arg.startsWith('--') ? (arg.split('=', 2) as [string, string?]) : [arg, undefined];
    if (valueSet.has(name)) {
      const value = inline ?? args[index + 1];
      if (value === undefined) fail(`option "${name}" requires a value`);
      if (inline === undefined) index += 1;
      options[name.replace(/^--?/, '')] = value;
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') fail(`unknown option "${arg}"`);
    positional.push(arg);
  }
  return { options, positional };
}

function onePositional(command: string, positional: string[], what: string): string | undefined {
  if (positional.length > 1) fail(`usage: dsvm ${command} ${what}`);
  return positional[0];
}

async function installCli(args: string[]): Promise<void> {
  const { options, positional } = parseOptions(args, { flags: ['--force', '-f'] });
  const spec = onePositional('install', positional, '[version|tag]');
  await installCommand(spec, { force: options.force === true });
}

async function useCli(args: string[]): Promise<void> {
  const { positional } = parseOptions(args);
  const spec = positional[0];
  if (!spec) fail('usage: dsvm use <version|tag>');
  await useCommand(spec);
}

async function updateCli(args: string[]): Promise<void> {
  const { positional } = parseOptions(args);
  const tag = onePositional('update', positional, '[tag]');
  await updateCommand(tag);
}

async function uninstallCli(args: string[]): Promise<void> {
  const { positional } = parseOptions(args);
  const target = positional[0];
  if (!target) fail('usage: dsvm uninstall <version|tag>');
  await uninstallCommand(target);
}

function tagsFor(state: ReturnType<typeof listState>, version: string): string[] {
  return Object.entries(state.tags)
    .filter(([, mapped]) => mapped === version)
    .map(([tag]) => tag);
}

function listCli(args: string[]): void {
  const { options, positional } = parseOptions(args, { flags: ['--json'] });
  if (positional.length > 0) fail('usage: dsvm list [--json]');
  const state = listState();

  if (options.json) {
    const infoByVersion: Record<string, { installedAt: string | null; tags: string[] }> = {};
    for (const version of state.installed) {
      infoByVersion[version] = {
        installedAt: state.config.installed[version]?.installedAt ?? null,
        tags: tagsFor(state, version),
      };
    }
    info(
      JSON.stringify(
        { current: state.current, installed: state.installed, tags: state.tags, info: infoByVersion },
        null,
        2,
      ),
    );
    return;
  }

  if (state.installed.length === 0) {
    info('no dsh versions installed; run `dsvm install`');
    return;
  }

  const width = Math.max(...state.installed.map((version) => version.length));
  info(dim(`installed in ${versionsDir()}`));
  info();
  for (const version of state.installed) {
    const marker = state.current?.version === version ? '*' : ' ';
    const tags = tagsFor(state, version);
    const installedAt = state.config.installed[version]?.installedAt;
    const details = [
      tags.length > 0 ? tags.join(', ') : null,
      installedAt ? `installed ${formatTimestamp(installedAt)}` : null,
    ]
      .filter((part): part is string => part !== null)
      .join('  ');
    info(details ? `${marker} ${version.padEnd(width)}  ${dim(details)}` : `${marker} ${version}`);
  }
  info();
  info(`current: ${describeCurrent(state.config)}`);
}

function currentCli(args: string[]): void {
  const { options, positional } = parseOptions(args, { flags: ['--json'] });
  if (positional.length > 0) fail('usage: dsvm current [--json]');
  const { current } = listState();
  if (options.json) {
    info(JSON.stringify({ current }, null, 2));
    return;
  }
  if (!current) {
    info('no active dsh version; run `dsvm install`');
    return;
  }
  const label = current.kind === 'tag' ? ` (${current.spec})` : ' (pinned)';
  info(`${current.version}${label}`);
}

async function openCli(args: string[]): Promise<void> {
  const { options, positional } = parseOptions(args, { flags: ['--print', '-p'] });
  if (positional.length > 0) fail('usage: dsvm open [--print]');
  await openCommand({ print: options.print === true || options.p === true });
}

const GENERAL_HELP = `dsvm — install, switch and serve @deepseek-ai/dsh

Usage:
  dsvm [open]                     Open the dsvm service web UI
  dsvm install [version|tag]      Install a version or dist-tag (default: latest)
  dsvm use <version|tag>          Switch the active dsh version
  dsvm update [tag]               Update a dist-tag to its newest version
  dsvm list [--json]              List installed versions and tagged releases
  dsvm uninstall <version|tag>    Remove an installed version
  dsvm current [--json]           Print the active version
  dsvm web [dsh args...]          Run \`dsh web\` in the foreground (handed off to dsh)
  dsvm plugin [dsh args...]       Run \`dsh plugin\` (default --profile web)
  dsvm desktop [install|uninstall|update]
                                  Run the dsh web UI in the bundled NW.js app
  dsvm service <subcommand>       Manage the background web service
  dsvm version                    Print the dsvm version
  dsvm help [command]             Show help

Examples:
  dsvm install                    install the latest release
  dsvm use alpha                  switch to whatever the alpha tag points at
  dsvm update                     update the dist-tag that is currently in use
  dsvm service install            install the systemd/launchd/Task Scheduler unit
  dsvm service enable             start the service now and at login
  dsvm open                       open the running service in a browser`;

const COMMAND_HELP: Record<string, string> = {
  install: 'Usage: dsvm install [version|tag] [--force]\n\nInstall a dsh version or dist-tag (default: latest).',
  use: 'Usage: dsvm use <version|tag>\n\nSwitch the active dsh version, installing it when needed.',
  update:
    'Usage: dsvm update [tag]\n\nUpdate a dist-tag to its newest version. Without a tag the currently\nused tag is updated; pinned versions must pass a tag or switch first.',
  uninstall: 'Usage: dsvm uninstall <version|tag>\n\nRemove an installed version that is not active.',
  list: 'Usage: dsvm list [--json]\n\nList installed versions and the dist-tags pointing at them.',
  current: 'Usage: dsvm current [--json]\n\nPrint the active dsh version.',
  web: 'Usage: dsvm web [dsh web args...]\n\nRun `dsh web` in the foreground using the active version. Outside service\nmode the process is handed over to dsh; all arguments are passed through.',
  plugin:
    'Usage: dsvm plugin [dsh plugin args...]\n\nRun `dsh plugin` in the foreground using the active version. When no\n--profile is given, `--profile web` is assumed. The process is handed\nover to dsh; all arguments are passed through.',
  open: 'Usage: dsvm [open] [--print]\n\nOpen the URL reported by `dsvm service url` in the default browser.\nWith --print the URL is printed as well. Use `dsvm service url` to print\nthe URL without opening a browser.',
};

export function helpText(topic?: string): string {
  if (!topic) return GENERAL_HELP;
  if (topic === 'service') return `Usage: dsvm service <subcommand>\n\n${serviceHelpText()}`;
  if (topic === 'desktop') return `Usage: dsvm desktop [install|uninstall|update]\n\n${desktopHelpText()}`;
  return COMMAND_HELP[topic] ?? `unknown command "${topic}"\n\n${GENERAL_HELP}`;
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case 'open':
      return openCli(rest);
    case 'install':
      return installCli(rest);
    case 'use':
      return useCli(rest);
    case 'update':
      return updateCli(rest);
    case 'uninstall':
      return uninstallCli(rest);
    case 'list':
    case 'ls':
      listCli(rest);
      return;
    case 'current':
      currentCli(rest);
      return;
    case 'web':
      return webCommand(rest);
    case 'plugin':
      return pluginCommand(rest);
    case 'desktop':
      return desktopCommand(rest);
    case 'service':
      return serviceCommand(rest);
    case 'version':
    case '--version':
    case '-V':
      info(`dsvm ${dsvmVersion}`);
      return;
    case 'help':
    case '--help':
    case '-h':
      info(helpText(rest[0]));
      return;
    default:
      fail(`unknown command "${command}"\n\n${GENERAL_HELP}`);
  }
}

export { dsvmVersion };
