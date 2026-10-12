export type ManagerId = 'systemd' | 'launchd' | 'schtasks';

export interface ServiceMeta {
  schema: 1;
  manager: ManagerId;
  installedAt: string;
  platform: NodeJS.Platform;
  port: number;
  host: string | null;
  dir: string;
  dsvmHome: string;
  dsvmBin: string;
  nodePath: string;
  pathEnv: string;
}

export interface ServiceState {
  schema: 1;
  url: string;
  /** PID of the dsh web child process. */
  pid: number;
  /** PID of the dsvm web wrapper process. */
  dsvmPid: number;
  port: number | null;
  version: string;
  startedAt: string;
}

export interface ServiceManager {
  id: ManagerId;
  label: string;
  location(): string;
  isInstalled(): boolean | Promise<boolean>;
  install(meta: ServiceMeta): Promise<void>;
  uninstall(): Promise<void>;
  enable(): Promise<void>;
  disable(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  isRunning(): Promise<boolean>;
  state(): Promise<string>;
}
