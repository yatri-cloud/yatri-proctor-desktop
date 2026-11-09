// Types for window.yp (electron/preload.cjs).
export type BlockedApp = { label: string; pids: number[] };
export type SystemInfo = {
  platform: string; os: string; arch: string; cpu: string; memoryGb: number; appVersion: string;
  displays: number; displayInfo: { w: number; h: number; internal: boolean }[];
  virtualMachine: string[]; remoteSession: boolean;
  permissions: { camera: string; microphone: string; screen: string };
  blocked: BlockedApp[];
  e2e?: boolean;
};
export type MainEvent = { kind: string; severity: number; detail: Record<string, unknown>; at: number };

type Bridge = {
  systemInfo(): Promise<SystemInfo>;
  askMedia(): Promise<{ camera: boolean; microphone: boolean }>;
  openPrivacy(pane: "camera" | "microphone" | "screen"): Promise<void>;
  scanApps(): Promise<BlockedApp[]>;
  requestScreen(): Promise<string>;
  relaunch(): Promise<void>;
  redeem?(code: string): Promise<{ ok: boolean; json: { error?: string; token_hash?: string; session_id?: string; email?: string } }>;
  closeApps(labels: string[]): Promise<BlockedApp[]>;
  lockdown(on: boolean): Promise<boolean>;
  confirmQuit(): Promise<boolean>;
  quit(): Promise<void>;
  onLaunch(cb: (code: string) => void): () => void;
  onEvent(cb: (e: MainEvent) => void): () => void;
  onCloseRequested(cb: () => void): () => void;
};

declare global { interface Window { yp?: Bridge } }

/** Browser fallback (vite dev without Electron) so screens still render. */
const fallback: Bridge = {
  systemInfo: async () => ({ platform: "web", os: navigator.userAgent, arch: "", cpu: "", memoryGb: 0, appVersion: "dev", displays: 1, displayInfo: [], virtualMachine: [], remoteSession: false, permissions: { camera: "granted", microphone: "granted", screen: "granted" }, blocked: [] }),
  askMedia: async () => ({ camera: true, microphone: true }),
  openPrivacy: async () => {}, scanApps: async () => [], requestScreen: async () => "granted", relaunch: async () => location.reload(), closeApps: async () => [],
  lockdown: async () => false, confirmQuit: async () => confirm("End your exam?"), quit: async () => {},
  onLaunch: () => () => {}, onEvent: () => () => {}, onCloseRequested: () => () => {},
};

export const yp: Bridge = window.yp ?? fallback;
