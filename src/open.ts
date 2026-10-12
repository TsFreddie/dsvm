import { spawn } from 'node:child_process';
import { serviceUrl } from './service/index.js';
import { DsvmError, commandExists, info } from './util.js';

export interface Opener {
  command: string;
  buildArgs: (url: string) => string[];
}

/** Pick a platform-appropriate URL opener. */
export function detectOpener(platform: NodeJS.Platform = process.platform): Opener | null {
  if (platform === 'win32') {
    return { command: 'rundll32.exe', buildArgs: (url) => ['url.dll,FileProtocolHandler', url] };
  }
  if (platform === 'darwin') {
    return { command: 'open', buildArgs: (url) => [url] };
  }
  const candidates: Opener[] = [];
  if (process.env.BROWSER) {
    candidates.push({ command: process.env.BROWSER, buildArgs: (url) => [url] });
  }
  candidates.push(
    { command: 'xdg-open', buildArgs: (url) => [url] },
    { command: 'gio', buildArgs: (url) => ['open', url] },
    { command: 'sensible-browser', buildArgs: (url) => [url] },
    { command: 'x-www-browser', buildArgs: (url) => [url] },
  );
  return candidates.find((candidate) => commandExists(candidate.command)) ?? null;
}

/** Launch a URL in the user's browser without waiting for it. */
export async function openUrl(url: string, { opener = detectOpener() }: { opener?: Opener | null } = {}): Promise<void> {
  if (!opener) {
    throw new DsvmError(`could not find a browser opener; open this URL manually:\n${url}`);
  }
  const child = spawn(opener.command, opener.buildArgs(url), {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (error) => {
      reject(new DsvmError(`could not launch ${opener.command}: ${error.message}`));
    });
  });
  child.unref();
}

/** `dsvm` / `dsvm open` — open the URL reported by `dsvm service url`. */
export async function openCommand({ print = false }: { print?: boolean } = {}): Promise<void> {
  const url = await serviceUrl();
  if (print) {
    info(url);
  } else {
    info('opening the dsvm service in your default browser');
  }
  await openUrl(url);
}
