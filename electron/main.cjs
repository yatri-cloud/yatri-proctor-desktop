/**
 * Yatri Proctor, main process.
 *
 * Responsibilities (renderer does the UI, exam and AI monitoring):
 *   - yatriproctor://launch?code=XXXX deep links (macOS open-url, Windows argv)
 *   - system test data: OS, displays, virtual machine and remote-session
 *     heuristics, camera/mic/screen permissions (macOS TCC)
 *   - blocked app scan (meeting, remote desktop, recorders, AI assistants)
 *     and closing them with the learner's consent
 *   - exam lockdown: kiosk full screen, always on top, content protection,
 *     display sleep blocked, common shortcuts swallowed, clipboard cleared,
 *     window close guarded; focus loss, display changes and shortcuts are
 *     reported to the renderer as proctoring events
 *
 * What cannot be blocked (and is logged instead): Ctrl+Alt+Del, Win+L,
 * Cmd+Tab / Cmd+Opt+Esc on macOS. On macOS 15 ScreenCaptureKit can still
 * capture a protected window, so capture blocking is best effort there.
 */
const { app, BrowserWindow, ipcMain, screen, powerSaveBlocker, globalShortcut, systemPreferences, clipboard, protocol, net, shell, session, dialog, desktopCapturer } = require('electron');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const si = require('systeminformation');

const DEV_URL = process.env.YP_DEV_URL || '';
const DIST = path.join(__dirname, '..', 'dist');
const SCHEME = 'yatriproctor';
const SITE_URL = process.env.YP_SITE_URL || 'https://www.yatricloud.com';
// Dev-only automated test mode (never in installed builds): fake camera, no
// app closing on the developer's machine, no kiosk takeover.
const E2E = !app.isPackaged && process.env.YP_E2E === '1';
if (E2E) {
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
}

let win = null;
let pendingLaunch = null;
let lockdown = { on: false, blocker: null, procTimer: null, clipTimer: null };

/* ------------------------------------------------------------ single instance + deep links */

// Automated tests may run next to a developer's open copy of the app.
if (!E2E && !app.requestSingleInstanceLock()) app.quit();

if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(SCHEME, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(SCHEME);
}

function launchCodeFrom(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== `${SCHEME}:`) return null;
    const code = (u.searchParams.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return /^[A-Z2-9]{8}$/.test(code) ? code : null;
  } catch { return null; }
}

function deliverLaunch(url) {
  const code = launchCodeFrom(url);
  if (!code) return;
  if (win && !win.webContents.isLoading()) win.webContents.send('yp:launch', code);
  else pendingLaunch = code;
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
}

app.on('open-url', (event, url) => { event.preventDefault(); deliverLaunch(url); });
app.on('second-instance', (_e, argv) => {
  const url = argv.find((a) => a.startsWith(`${SCHEME}://`));
  if (url) deliverLaunch(url);
  else if (win) win.focus();
});
const argUrl = process.argv.find((a) => a.startsWith(`${SCHEME}://`));
if (argUrl) pendingLaunch = launchCodeFrom(argUrl);

/* ------------------------------------------------------------ app:// protocol for the renderer */

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

function serveDist() {
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

/* ------------------------------------------------------------ window */

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 980,
    minHeight: 680,
    title: 'Yatri Proctor',
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: !app.isPackaged,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadURL(DEV_URL || 'app://yp/index.html');
  win.webContents.on('did-finish-load', () => {
    if (pendingLaunch) { win.webContents.send('yp:launch', pendingLaunch); pendingLaunch = null; }
  });
  // Links open in the real browser; the app never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://') && !url.startsWith(DEV_URL || '#')) e.preventDefault(); });

  // During the exam: block reload, devtools, close and zoom keys inside the app.
  win.webContents.on('before-input-event', (event, input) => {
    if (!lockdown.on) return;
    const k = String(input.key || '').toLowerCase();
    const mod = input.control || input.meta;
    if ((mod && ['r', 'w', 'q', 'p', 's', 'n', 't', 'h', 'm', '+', '-', '=', '0'].includes(k)) || k === 'f5' || k === 'f11' || k === 'f12' || (input.alt && k === 'f4') || (mod && input.shift && k === 'i')) {
      event.preventDefault();
      report('shortcut', 1, { key: [input.control && 'Ctrl', input.meta && 'Cmd', input.alt && 'Alt', input.shift && 'Shift', input.key].filter(Boolean).join('+') });
    }
  });
  win.on('close', (e) => {
    if (lockdown.on) { e.preventDefault(); win.webContents.send('yp:close-requested'); }
  });
  win.on('blur', () => { if (lockdown.on) report('focus_lost', 2, { phase: 'start' }); });
  win.on('focus', () => { if (lockdown.on) report('focus_lost', 2, { phase: 'end' }); });
  win.on('leave-full-screen', () => {
    if (!lockdown.on) return;
    report('fullscreen_exit', 2, {});
    setTimeout(() => win && lockdown.on && win.setKiosk(true), 300);
  });
  win.on('minimize', () => { if (lockdown.on) { report('focus_lost', 2, { phase: 'minimize' }); win.restore(); } });
}

function report(kind, severity, detail) {
  if (win) win.webContents.send('yp:event', { kind, severity, detail, at: Date.now() });
}

/* ------------------------------------------------------------ system checks */

// Process names (lowercase, matched as whole words) that must not run during an exam.
const BLOCKED = [
  ['teamviewer', 'TeamViewer'], ['anydesk', 'AnyDesk'], ['rustdesk', 'RustDesk'], ['parsec', 'Parsec'],
  ['screenconnect', 'ScreenConnect'], ['remoting_host', 'Chrome Remote Desktop'], ['mstsc', 'Remote Desktop'],
  ['vncserver', 'VNC'], ['tvnserver', 'TightVNC'], ['winvnc', 'VNC'], ['splashtop', 'Splashtop'],
  ['zoom', 'Zoom'], ['zoom.us', 'Zoom'], ['teams', 'Microsoft Teams'], ['ms-teams', 'Microsoft Teams'],
  ['slack', 'Slack'], ['discord', 'Discord'], ['skype', 'Skype'], ['webex', 'Webex'], ['ciscowebex', 'Webex'],
  ['telegram', 'Telegram'], ['whatsapp', 'WhatsApp'], ['signal', 'Signal'], ['facetime', 'FaceTime'], ['messenger', 'Messenger'],
  ['obs', 'OBS Studio'], ['obs64', 'OBS Studio'], ['streamlabs', 'Streamlabs'], ['xsplit', 'XSplit'], ['camtasia', 'Camtasia'],
  ['snagit', 'Snagit'], ['bandicam', 'Bandicam'], ['sharex', 'ShareX'], ['loom', 'Loom'], ['screenflow', 'ScreenFlow'],
  ['manycam', 'ManyCam'], ['snapcamera', 'Snap Camera'],
  ['chatgpt', 'ChatGPT'], ['claude', 'Claude'], ['copilot', 'Copilot'], ['gemini', 'Gemini'], ['perplexity', 'Perplexity'],
  ['cluely', 'Cluely'], ['interviewcoder', 'Interview Coder'], ['lm studio', 'LM Studio'], ['ollama', 'Ollama'],
];

function findBlocked(list) {
  const found = new Map();
  for (const p of list) {
    const name = String(p.name || '').toLowerCase().replace(/\.(exe|app)$/, '');
    for (const [token, label] of BLOCKED) {
      const re = new RegExp(`(^|[^a-z])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`);
      if (re.test(name) && p.pid !== process.pid) {
        const entry = found.get(label) || { label, pids: [] };
        entry.pids.push(p.pid);
        found.set(label, entry);
      }
    }
  }
  return [...found.values()];
}

async function scanProcesses() {
  if (E2E) return [];
  try {
    const { list } = await si.processes();
    return findBlocked(list);
  } catch { return []; }
}

function sysctl(key) {
  return new Promise((resolve) => execFile('sysctl', ['-n', key], (err, out) => resolve(err ? '' : String(out).trim())));
}

async function virtualMachine() {
  const hints = [];
  try {
    const sys = await si.system();
    const text = `${sys.manufacturer} ${sys.model} ${sys.version}`;
    if (/vmware|virtualbox|qemu|kvm|parallels|hyper-v|xen|virtual machine|bochs|utm/i.test(text) || sys.virtual) hints.push(text.trim());
    const g = await si.graphics();
    for (const c of g.controllers || []) if (/vmware|virtualbox|parallels|qxl|virtio|basic display|llvmpipe|swiftshader/i.test(`${c.vendor} ${c.model}`)) hints.push(c.model);
    if (process.platform === 'darwin' && (await sysctl('kern.hv_vmm_present')) === '1') hints.push('macOS hypervisor flag');
  } catch { /* best effort */ }
  return hints;
}

function permission(kind) {
  if (process.platform !== 'darwin' || E2E) return 'granted';
  try { return systemPreferences.getMediaAccessStatus(kind); } catch { return 'unknown'; }
}

ipcMain.handle('yp:system-info', async () => {
  const [osInfo, cpu, mem, vm, blocked] = await Promise.all([si.osInfo(), si.cpu(), si.mem(), virtualMachine(), scanProcesses()]);
  const displays = screen.getAllDisplays();
  return {
    platform: process.platform,
    os: `${osInfo.distro} ${osInfo.release}`,
    arch: osInfo.arch,
    cpu: `${cpu.manufacturer} ${cpu.brand}`.trim(),
    memoryGb: Math.round(mem.total / 1e9),
    appVersion: app.getVersion(),
    displays: displays.length,
    displayInfo: displays.map((d) => ({ w: d.size.width, h: d.size.height, internal: d.internal })),
    virtualMachine: vm,
    remoteSession: process.platform === 'win32' && /^RDP-/i.test(process.env.SESSIONNAME || ''),
    permissions: { camera: permission('camera'), microphone: permission('microphone'), screen: permission('screen') },
    blocked,
    e2e: E2E,
  };
});

ipcMain.handle('yp:ask-media', async () => {
  if (process.platform !== 'darwin') return { camera: true, microphone: true };
  const camera = await systemPreferences.askForMediaAccess('camera').catch(() => false);
  const microphone = await systemPreferences.askForMediaAccess('microphone').catch(() => false);
  return { camera, microphone };
});

ipcMain.handle('yp:open-privacy', (_e, pane) => {
  const panes = {
    camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
    microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  };
  if (process.platform === 'darwin' && panes[pane]) shell.openExternal(panes[pane]);
});

ipcMain.handle('yp:scan-apps', () => scanProcesses());

// macOS lists an app under Screen Recording only after it asks once. Asking
// shows the system prompt; the answer applies after the app restarts.
ipcMain.handle('yp:request-screen', async () => {
  if (process.platform === 'darwin' && !E2E) {
    try { await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }); } catch { /* prompt shown or denied */ }
  }
  return permission('screen');
});

// Restart so new macOS privacy settings take effect. The session resumes from
// local storage; the used launch link is not passed again.
ipcMain.handle('yp:relaunch', () => {
  exitLockdown();
  app.relaunch({ args: process.argv.slice(1).filter((a) => !a.startsWith(`${SCHEME}://`)) });
  app.exit(0);
});

// Launch code exchange runs here (not in the page) so the website API needs
// no cross-origin access for app://.
ipcMain.handle('yp:redeem', async (_e, code) => {
  const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const res = await fetch(`${SITE_URL}/api/pass/proctor.redeem`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': `YatriProctor/${app.getVersion()}` },
    body: JSON.stringify({ code: clean }), signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, json };
});

// Closes the listed blocked apps. The renderer only calls this after the
// learner pressed "Close these apps".
ipcMain.handle('yp:close-apps', async (_e, labels) => {
  const found = await scanProcesses();
  const wanted = new Set(Array.isArray(labels) ? labels : []);
  for (const entry of found) {
    if (!wanted.has(entry.label)) continue;
    for (const pid of entry.pids) { try { process.kill(pid); } catch { /* already gone or not ours */ } }
  }
  await new Promise((r) => setTimeout(r, 1500));
  return scanProcesses();
});

/* ------------------------------------------------------------ lockdown */

const SWALLOW = ['CommandOrControl+Tab', 'Alt+Tab', 'Alt+Space', 'Alt+F4', 'CommandOrControl+Q', 'CommandOrControl+W', 'CommandOrControl+H',
  'CommandOrControl+M', 'CommandOrControl+R', 'CommandOrControl+Shift+I', 'F11', 'F12', 'PrintScreen',
  'CommandOrControl+Shift+3', 'CommandOrControl+Shift+4', 'CommandOrControl+Shift+5', 'Super+D', 'Super+Tab'];

function enterLockdown() {
  if (!win || lockdown.on) return;
  lockdown.on = true;
  if (E2E) return; // keep the developer's screen usable during automated tests
  win.setKiosk(true);
  win.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setContentProtection(true);
  lockdown.blocker = powerSaveBlocker.start('prevent-display-sleep');
  for (const acc of SWALLOW) {
    try { globalShortcut.register(acc, () => report('shortcut', 1, { key: acc })); } catch { /* OS-reserved */ }
  }
  clipboard.clear();
  lockdown.clipTimer = setInterval(() => clipboard.clear(), 4000);
  lockdown.procTimer = setInterval(async () => {
    const blocked = await scanProcesses();
    if (blocked.length) report('blocked_app', 3, { apps: blocked.map((b) => b.label) });
  }, 20000);
  screen.on('display-added', onDisplayAdded);
}

function onDisplayAdded() { report('display_added', 3, { displays: screen.getAllDisplays().length }); }

function exitLockdown() {
  if (!lockdown.on) return;
  lockdown.on = false;
  if (E2E) return;
  globalShortcut.unregisterAll();
  clearInterval(lockdown.clipTimer);
  clearInterval(lockdown.procTimer);
  screen.removeListener('display-added', onDisplayAdded);
  if (lockdown.blocker !== null && powerSaveBlocker.isStarted(lockdown.blocker)) powerSaveBlocker.stop(lockdown.blocker);
  if (win) {
    win.setContentProtection(false);
    win.setAlwaysOnTop(false);
    if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(false);
    win.setKiosk(false);
  }
}

ipcMain.handle('yp:lockdown', (_e, on) => { on ? enterLockdown() : exitLockdown(); return lockdown.on; });
ipcMain.handle('yp:quit', () => { exitLockdown(); app.quit(); });
ipcMain.handle('yp:confirm-quit', async () => {
  const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Keep going', 'End exam and quit'], defaultId: 0, cancelId: 0,
    message: 'End your exam?', detail: 'Your answers so far are saved. Ending now submits the exam.' });
  return r.response === 1;
});

/* ------------------------------------------------------------ boot */

app.whenReady().then(() => {
  serveDist();
  // Camera and microphone for the app's own pages only.
  session.defaultSession.setPermissionRequestHandler((wc, permissionName, cb, details) => {
    const origin = String(details?.requestingUrl || wc.getURL());
    const ours = origin.startsWith('app://') || (DEV_URL && origin.startsWith(DEV_URL));
    cb(ours && ['media', 'mediaKeySystem', 'clipboard-sanitized-write'].includes(permissionName));
  });
  createWindow();
  if (process.argv.includes('--smoke')) {
    // CI smoke test: boot, load the UI, collect system info, quit.
    win.webContents.once('did-finish-load', async () => {
      const ok = await win.webContents.executeJavaScript('Boolean(document.getElementById("root")?.children.length)').catch(() => false);
      const model = await win.webContents.executeJavaScript('window.__ypModelTest()').catch((e) => `fail ${e.message}`);
      const info = await virtualMachine().then((vm) => `vm:${vm.length ? vm.join('|') : 'none'}`);
      const blocked = (await scanProcesses()).map((b) => b.label).join(',') || 'none';
      const shot = process.env.YP_SMOKE_SHOT;
      if (shot) require('node:fs').writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
      console.log(`smoke: renderer ${ok ? 'ok' : 'EMPTY'} · face model ${model} · ${info} · displays:${screen.getAllDisplays().length} · blocked:${blocked}`);
      app.exit(ok && model === 'ok' ? 0 : 1);
    });
  }
});

app.on('window-all-closed', () => { exitLockdown(); app.quit(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
