import { spawn } from 'node:child_process';
import { desktopAppDir, ensureNwjs } from './nwjs.js';
import { info } from '../util.js';

/**
 * `dsvm desktop` —— 确保 nw.js SDK 缓存就绪（缺失则自动下载最新版），
 * 然后以后台方式启动内置 nw.js 应用。spawn detached，终端可直接返回。
 */
export async function launchDesktop(): Promise<void> {
  const { version, binary } = await ensureNwjs();
  const appDir = desktopAppDir();
  const child = spawn(binary, [appDir], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env },
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (error) => reject(error));
  });
  child.unref();
  info(`launched dsvm desktop (nw.js SDK ${version})`);
}
