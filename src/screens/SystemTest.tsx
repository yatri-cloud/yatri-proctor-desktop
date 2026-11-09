import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Card, Shell, cx } from "../ui";
import { yp, type SystemInfo } from "../lib/bridge";
import { logEvent, supabase, type Session } from "../lib/api";
import { measureConnection, type NetProgress, type NetResult } from "../lib/speedtest";

/*
 * System test, one page per check (like Pearson OnVUE): devices, camera,
 * microphone, speaker, connection, screens, computer, background apps and,
 * on macOS, permissions. Next unlocks only when the check on the page passes;
 * the last page goes straight to check-in. Every page has a troubleshooting
 * guide. Background apps can be skipped for now; the skip is recorded on the
 * session and as a low-severity flag for the reviewer. Progress is kept in
 * local storage so a restart (needed for macOS Screen Recording) resumes here.
 */

export type CheckResults = {
  camera?: string; microphone?: string; speaker?: string;
  network?: NetResult;
  displays?: number; virtualMachine?: string[]; remoteSession?: boolean;
  blockedApps?: string[]; appsSkipped?: boolean; permissions?: SystemInfo["permissions"];
};

type StepKey = "devices" | "camera" | "mic" | "speaker" | "network" | "screens" | "computer" | "apps" | "permissions";
const MIN_DOWN = 6;
const MIN_UP = 2;
const MAX_LATENCY = 800;
const PROGRESS = (id: string) => `yp-system-test:${id}`;
type Saved = { i: number; results: CheckResults; camId: string; micId: string; spkId: string; at: number };

function loadSaved(id: string): Saved | null {
  try {
    const v = JSON.parse(localStorage.getItem(PROGRESS(id)) || "null") as Saved | null;
    return v && Date.now() - v.at < 30 * 60_000 ? v : null;
  } catch { return null; }
}

export default function SystemTest({ session, onPass }: { session: Session; onPass: (d: SystemInfo & { checks: CheckResults }, s: MediaStream) => void }) {
  const saved = useRef(loadSaved(session.id)).current;
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [camId, setCamId] = useState(saved?.camId || "");
  const [micId, setMicId] = useState(saved?.micId || "");
  const [spkId, setSpkId] = useState(saved?.spkId || "");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [results, setResults] = useState<CheckResults>(saved?.results || {});
  const [i, setI] = useState(saved?.i || 0);
  const [busy, setBusy] = useState(false);
  const handedOff = useRef(false);

  const mac = info?.platform === "darwin";
  const steps: StepKey[] = ["devices", "camera", "mic", "speaker", "network", "screens", "computer", "apps", ...(mac ? ["permissions" as StepKey] : [])];
  const step = steps[Math.min(i, steps.length - 1)];
  const last = i >= steps.length - 1;
  const refresh = useCallback(async () => { const s = await yp.systemInfo(); setInfo(s); return s; }, []);

  useEffect(() => {
    try { localStorage.setItem(PROGRESS(session.id), JSON.stringify({ i, results, camId, micId, spkId, at: Date.now() } satisfies Saved)); } catch { /* storage full or blocked */ }
  }, [session.id, i, results, camId, micId, spkId]);

  // Permissions first (macOS prompt), then the device list.
  useEffect(() => {
    (async () => {
      await yp.askMedia();
      await refresh();
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        probe.getTracks().forEach((t) => t.stop());
      } catch (e) {
        setMediaError((e as Error).name === "NotAllowedError" ? "Camera or microphone access is blocked." : "No camera or microphone was found.");
      }
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices(list);
      const keep = (id: string, kind: MediaDeviceKind) => (list.some((d) => d.kind === kind && d.deviceId === id) ? id : list.find((d) => d.kind === kind)?.deviceId || "");
      setCamId((v) => keep(v, "videoinput"));
      setMicId((v) => keep(v, "audioinput"));
      setSpkId((v) => keep(v, "audiooutput"));
    })();
    const onChange = () => navigator.mediaDevices.enumerateDevices().then(setDevices);
    navigator.mediaDevices.addEventListener("devicechange", onChange);
    return () => navigator.mediaDevices.removeEventListener("devicechange", onChange);
  }, [refresh]);

  // One stream for the chosen camera + microphone, reopened when they change.
  // The stream handed to check-in must stay open, so it is not stopped then.
  useEffect(() => {
    if (!camId && !micId) return;
    let alive = true;
    let s: MediaStream | null = null;
    navigator.mediaDevices.getUserMedia({
      video: camId ? { deviceId: { exact: camId }, width: 1280, height: 720 } : true,
      audio: micId ? { deviceId: { exact: micId }, echoCancellation: false, noiseSuppression: false } : true,
    }).then((st) => { if (!alive) { st.getTracks().forEach((t) => t.stop()); return; } s = st; setStream(st); setMediaError(null); })
      .catch((e) => setMediaError((e as Error).name === "NotAllowedError" ? "Camera or microphone access is blocked." : "This camera or microphone cannot be opened. Choose another one."));
    return () => { alive = false; if (!handedOff.current) s?.getTracks().forEach((t) => t.stop()); };
  }, [camId, micId]);

  const save = (patch: CheckResults) => setResults((r) => ({ ...r, ...patch }));
  const back = () => setI((k) => Math.max(k - 1, 0));
  const label = (id: string, kind: MediaDeviceKind) => devices.find((d) => d.deviceId === id && d.kind === kind)?.label || "Default";

  async function advance(patch: CheckResults) {
    const all = { ...results, ...patch };
    setResults(all);
    if (!last) { setI((k) => k + 1); return; }
    if (!info || !stream) return;
    setBusy(true);
    try {
      if (all.appsSkipped) await logEvent(session.id, { kind: "blocked_app", severity: 1, detail: { skipped_at_system_test: true, apps: all.blockedApps } });
      await supabase.auth.refreshSession();
      handedOff.current = true;
      localStorage.removeItem(PROGRESS(session.id));
      onPass({ ...info, checks: all }, stream);
    } finally { setBusy(false); }
  }
  const nextLabel = (name: string) => (last ? (busy ? "Preparing…" : "Continue to check-in") : `Next: ${name}`);

  return (
    <Shell step={0} title="System test" subtitle={`${session.exam_code || "Your exam"} · Use the same computer, room and network for the whole exam.`}>
      <div className="max-w-4xl">
        {step === "devices" && (
          <DevicesStep info={info} devices={devices} camId={camId} micId={micId} spkId={spkId} setCamId={setCamId} setMicId={setMicId} setSpkId={setSpkId}
            error={mediaError} onNext={() => advance({})} />
        )}
        {step === "camera" && <CameraStep stream={stream} error={mediaError} mac={mac} onBack={back} onPass={() => advance({ camera: label(camId, "videoinput") })} />}
        {step === "mic" && <MicStep stream={stream} mac={mac} onBack={back} onPass={() => advance({ microphone: label(micId, "audioinput") })} />}
        {step === "speaker" && <SpeakerStep sinkId={spkId} mac={mac} onBack={back} onPass={() => advance({ speaker: label(spkId, "audiooutput") })} />}
        {step === "network" && <NetworkStep onBack={back} onPass={(n) => advance({ network: n })} />}
        {step === "screens" && <ScreensStep info={info} mac={mac} refresh={refresh} onBack={back} onPass={(d) => advance({ displays: d })} />}
        {step === "computer" && <ComputerStep info={info} onBack={back} onPass={() => advance({ virtualMachine: info?.virtualMachine, remoteSession: info?.remoteSession })} next={nextLabel("background apps")} />}
        {step === "apps" && <AppsStep info={info} refresh={refresh} onBack={back} next={nextLabel("permissions")} busy={busy} onPass={(apps, skipped) => advance({ blockedApps: apps, appsSkipped: skipped })} />}
        {step === "permissions" && <PermissionsStep info={info} refresh={refresh} onBack={back} next={nextLabel("")} busy={busy} onPass={() => advance({ permissions: info?.permissions })} />}
      </div>
    </Shell>
  );
}

/* ---------------------------------------------------------------- page frame */

function Page({ title, intro, status, children, actions, help }: { title: string; intro: ReactNode; status?: { ok: boolean | null; text: string }; children?: ReactNode; actions: ReactNode; help: ReactNode[] }) {
  return (
    <Card className="p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl font-bold tracking-tight">{title}</h2>
          <div className="mt-2 max-w-2xl text-[15px] text-muted">{intro}</div>
        </div>
        {status && (
          <span role="status" className={cx("shrink-0 rounded-full px-3 py-1 text-sm font-semibold",
            status.ok === true ? "bg-brand text-white" : status.ok === false ? "bg-ink text-white" : "border border-line text-muted")}>
            {status.text}
          </span>
        )}
      </div>
      {children && <div className="mt-6">{children}</div>}
      <details className="group mt-6 rounded-xl border border-line bg-canvas px-4 py-3 text-sm">
        <summary className="cursor-pointer select-none font-semibold text-ink marker:text-muted">Having trouble? Fix it here</summary>
        <ol className="mt-3 list-decimal space-y-2 pl-5 leading-relaxed text-ink/80">{help.map((h, k) => <li key={k}>{h}</li>)}</ol>
        <p className="mt-3 text-xs text-muted">Still stuck? Email info@yatricloud.com with a screenshot of this page.</p>
      </details>
      <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-6">{actions}</div>
    </Card>
  );
}

const Back = ({ onClick }: { onClick: () => void }) => <Button variant="ghost" onClick={onClick}>Back</Button>;
const Link = ({ onClick, children }: { onClick: () => void; children: ReactNode }) => <button type="button" className="font-semibold text-brand underline underline-offset-2" onClick={onClick}>{children}</button>;

/* ---------------------------------------------------------------- 1. devices */

function DevicesStep(p: {
  info: SystemInfo | null; devices: MediaDeviceInfo[]; camId: string; micId: string; spkId: string;
  setCamId: (v: string) => void; setMicId: (v: string) => void; setSpkId: (v: string) => void; error: string | null; onNext: () => void;
}) {
  const cams = p.devices.filter((d) => d.kind === "videoinput");
  const mics = p.devices.filter((d) => d.kind === "audioinput");
  const spks = p.devices.filter((d) => d.kind === "audiooutput");
  const ok = cams.length > 0 && mics.length > 0 && !p.error;
  const mac = p.info?.platform === "darwin";
  const Select = ({ id, label, value, list, onChange }: { id: string; label: string; value: string; list: MediaDeviceInfo[]; onChange: (v: string) => void }) => (
    <div>
      <label htmlFor={id} className="text-sm font-semibold">{label} <span className="font-normal text-muted">({list.length} found)</span></label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={!list.length}
        className="mt-1.5 h-12 w-full rounded-xl border border-line bg-white px-3 text-[15px] outline-none focus:border-brand">
        {list.length ? list.map((d, k) => <option key={d.deviceId || k} value={d.deviceId}>{d.label || `${label} ${k + 1}`}</option>) : <option>None found</option>}
      </select>
    </div>
  );
  return (
    <Page title="Your devices" intro="These are the devices connected to this computer. Choose the camera, microphone and speaker you will use for the exam."
      status={{ ok: p.devices.length ? ok : null, text: !p.devices.length ? "Looking…" : ok ? "Devices found" : "Fix needed" }}
      actions={<Button onClick={p.onNext} disabled={!ok}>Next: camera</Button>}
      help={[
        "Plug in an external webcam or USB microphone before opening Yatri Proctor, or wait a few seconds: the list updates by itself.",
        mac ? <>If the lists are empty or say access is blocked, allow Yatri Proctor in <Link onClick={() => yp.openPrivacy("camera")}>Camera settings</Link> and <Link onClick={() => yp.openPrivacy("microphone")}>Microphone settings</Link>, then <Link onClick={() => yp.relaunch()}>quit and reopen</Link>.</>
          : "If the lists are empty, open Windows Settings, Privacy & security, Camera and Microphone, and turn on access for desktop apps.",
        "Close Zoom, Teams, Meet, OBS or any app that may be using the camera. Only one app can use it at a time.",
        "Choose the built-in speakers. Headphones and earbuds are not allowed during the exam.",
      ]}>
      <div className="grid gap-4 sm:grid-cols-3">
        <Select id="cam" label="Camera" value={p.camId} list={cams} onChange={p.setCamId} />
        <Select id="mic" label="Microphone" value={p.micId} list={mics} onChange={p.setMicId} />
        <Select id="spk" label="Speaker" value={p.spkId} list={spks} onChange={p.setSpkId} />
      </div>
      {p.error && <p role="alert" className="mt-4 text-sm font-semibold">{p.error} {mac && <Link onClick={() => yp.openPrivacy("camera")}>Open camera settings</Link>}</p>}
      {p.info && (
        <dl className="mt-6 grid gap-x-6 gap-y-3 rounded-xl border border-line p-4 text-sm sm:grid-cols-2">
          {[["System", p.info.os],
            ["Screens", p.info.displayInfo.map((d) => `${d.w}×${d.h}${d.internal ? " (built in)" : ""}`).join(", ") || String(p.info.displays)],
            ["Yatri Proctor", p.info.appVersion]].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4"><dt className="text-muted">{k}</dt><dd className="text-right font-medium">{v}</dd></div>
          ))}
        </dl>
      )}
    </Page>
  );
}

/* ---------------------------------------------------------------- 2. camera */

function CameraStep({ stream, error, mac, onBack, onPass }: { stream: MediaStream | null; error: string | null; mac: boolean; onBack: () => void; onPass: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [signal, setSignal] = useState<"wait" | "ok" | "dark" | "frozen">("wait");
  useEffect(() => {
    if (!video.current || !stream) return;
    video.current.srcObject = stream;
    video.current.play().catch(() => {});
    // Automatic check: a live picture (frames change) that is not black.
    const c = document.createElement("canvas");
    c.width = 32; c.height = 18;
    const g = c.getContext("2d", { willReadFrequently: true })!;
    let prev: Uint8ClampedArray | null = null;
    let still = 0;
    const t = setInterval(() => {
      const v = video.current;
      if (!v || v.readyState < 2) return;
      g.drawImage(v, 0, 0, 32, 18);
      const d = g.getImageData(0, 0, 32, 18).data;
      let sum = 0, diff = 0;
      for (let k = 0; k < d.length; k += 4) { sum += d[k] + d[k + 1] + d[k + 2]; if (prev) diff += Math.abs(d[k] - prev[k]); }
      still = prev && diff === 0 ? still + 1 : 0;
      prev = d;
      const live = stream.getVideoTracks()[0]?.readyState === "live";
      setSignal(!live || still >= 6 ? "frozen" : sum / (d.length / 4) / 3 > 18 ? "ok" : "dark");
    }, 500);
    return () => clearInterval(t);
  }, [stream]);
  const status = error ? { ok: false, text: "No camera" } : signal === "ok" ? { ok: true, text: "Picture received" } : signal === "dark" ? { ok: false, text: "Picture too dark" } : signal === "frozen" ? { ok: false, text: "Picture frozen" } : { ok: null, text: "Starting…" };
  return (
    <Page title="Camera" intro="Sit where you will take the exam. Your whole face should be visible, well lit from the front, with nothing covering the camera."
      status={status}
      actions={<><Back onClick={onBack} /><Button onClick={onPass} disabled={signal !== "ok"}>Yes, I can see myself clearly</Button></>}
      help={[
        "Black picture: remove any lens cover or privacy shutter, and check the camera light is on.",
        "Wrong camera (for example a phone camera or a virtual camera): go Back and choose another one.",
        "Picture frozen: another app may hold the camera. Quit Zoom, Teams, Meet or OBS, then go Back and choose the camera again.",
        "Too dark: face a window or lamp. Light behind you makes your face dark.",
        mac ? <>Still black: allow Yatri Proctor in <Link onClick={() => yp.openPrivacy("camera")}>Camera settings</Link>, then <Link onClick={() => yp.relaunch()}>quit and reopen</Link>.</>
          : "Still black: in Windows Settings, Privacy & security, Camera, turn on Let desktop apps access your camera.",
      ]}>
      <div className="mx-auto max-w-xl overflow-hidden rounded-2xl bg-ink">
        <video ref={video} muted playsInline className="aspect-video w-full -scale-x-100 object-cover" />
      </div>
      {signal === "dark" && <p className="mt-3 text-center text-sm font-semibold">The picture is dark. Uncover the camera, add light, or choose another camera.</p>}
      {signal === "frozen" && <p className="mt-3 text-center text-sm font-semibold">The picture is not moving. Another app may be using the camera.</p>}
    </Page>
  );
}

/* ---------------------------------------------------------------- 3. microphone */

function MicStep({ stream, mac, onBack, onPass }: { stream: MediaStream | null; mac: boolean; onBack: () => void; onPass: () => void }) {
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState(0);
  useEffect(() => {
    if (!stream) return;
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(new ArrayBuffer(an.fftSize * 4));
    let floor = 0.01; // room noise, learned while quiet
    const loop = () => {
      an.getFloatTimeDomainData(buf);
      let s = 0; for (const v of buf) s += v * v;
      const rms = Math.sqrt(s / buf.length);
      if (rms < floor * 1.5) floor = floor * 0.95 + rms * 0.05;
      setLevel(rms);
      // Speech: clearly above the room noise, not a steady hum.
      if (rms > Math.max(0.03, floor * 3)) setHeard((h) => Math.min(100, h + 2.5));
    };
    ctx.resume().catch(() => {});
    const t = setInterval(loop, 40); // ~1.6 s of speech fills the bar
    return () => { clearInterval(t); ctx.close().catch(() => {}); };
  }, [stream]);
  const ok = heard >= 100;
  return (
    <Page title="Microphone" intro={<>Say this out loud at a normal volume: <span className="font-semibold text-ink">"My name is … and I am ready for my exam."</span></>}
      status={{ ok: ok ? true : null, text: ok ? "We can hear you" : heard > 0 ? "Keep talking…" : "Listening…" }}
      actions={<><Back onClick={onBack} /><Button onClick={onPass} disabled={!ok}>Next: speaker</Button></>}
      help={[
        "Bars do not move: go Back and pick another microphone. On a laptop, choose the built-in one.",
        "Check the mute switch on your headset or USB microphone, and the mute key on your keyboard.",
        mac ? <>Allow Yatri Proctor in <Link onClick={() => yp.openPrivacy("microphone")}>Microphone settings</Link>, then <Link onClick={() => yp.relaunch()}>quit and reopen</Link>. Also check System Settings, Sound, Input level.</>
          : "In Windows Settings, System, Sound, Input, check the volume is not at zero and the device is not disabled.",
        "Speak for a few seconds at a normal voice. Background noise alone does not count.",
      ]}>
      <div className="mx-auto max-w-xl">
        <p className="text-sm text-muted">Input level</p>
        <div className="mt-2 flex h-10 items-end gap-1" aria-hidden="true">
          {Array.from({ length: 32 }, (_, k) => (
            <span key={k} className={cx("flex-1 rounded-sm transition-[height]", k / 32 < Math.min(1, level * 9) ? "bg-brand" : "bg-line")} style={{ height: `${30 + ((k * 37) % 70)}%` }} />
          ))}
        </div>
        <div className="mt-6 h-2 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-ink transition-[width]" style={{ width: `${heard}%` }} /></div>
        <p className="mt-2 text-xs text-muted">Speech heard: {Math.round(heard)}%</p>
      </div>
    </Page>
  );
}

/* ---------------------------------------------------------------- 4. speaker */

function SpeakerStep({ sinkId, mac, onBack, onPass }: { sinkId: string; mac: boolean; onBack: () => void; onPass: () => void }) {
  const [played, setPlayed] = useState(false);
  const [answer, setAnswer] = useState<"yes" | "no" | null>(null);
  const [routeError, setRouteError] = useState(false);
  async function play() {
    // A short two-note chime, routed to the chosen speaker.
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    for (const [f, start] of [[660, 0], [880, 0.35]] as const) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + start);
      g.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime + start + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + 0.6);
      o.connect(g).connect(dest);
      o.start(ctx.currentTime + start);
      o.stop(ctx.currentTime + start + 0.65);
    }
    const audio = new Audio();
    audio.srcObject = dest.stream;
    const sink = audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    setRouteError(false);
    if (sinkId && sink.setSinkId) await sink.setSinkId(sinkId).catch(() => setRouteError(true));
    await audio.play().catch(() => {});
    setTimeout(() => { audio.pause(); ctx.close().catch(() => {}); }, 1400);
    setPlayed(true);
    setAnswer(null);
  }
  return (
    <Page title="Speaker" intro="Turn your volume up and play the test sound. Headphones and earbuds are not allowed during the exam, so use the computer's speakers."
      status={{ ok: answer === "yes" ? true : answer === "no" ? false : null, text: answer === "yes" ? "Sound works" : answer === "no" ? "Not heard" : "Not tested" }}
      actions={<><Back onClick={onBack} /><Button onClick={onPass} disabled={answer !== "yes"}>Next: connection</Button></>}
      help={[
        "Turn the volume up and check mute is off (the speaker key on your keyboard).",
        "Go Back and choose the built-in speakers. A Bluetooth or HDMI device may be selected instead.",
        mac ? "In System Settings, Sound, Output, select the internal speakers." : "In Windows Settings, System, Sound, Output, select the speakers and check the volume.",
        "Disconnect Bluetooth headphones: macOS and Windows often switch sound to them by themselves.",
      ]}>
      <div className="mx-auto flex max-w-xl flex-col items-center gap-5 text-center">
        <Button variant="outline" onClick={play}>{played ? "Play again" : "Play test sound"}</Button>
        {routeError && <p className="text-sm font-semibold">The chosen speaker could not be used, so the sound played on the default one.</p>}
        {played && (
          <div>
            <p className="font-semibold">Did you hear the sound?</p>
            <div className="mt-3 flex justify-center gap-3">
              <Button onClick={() => setAnswer("yes")} variant={answer === "yes" ? "primary" : "outline"}>Yes</Button>
              <Button onClick={() => setAnswer("no")} variant={answer === "no" ? "primary" : "outline"}>No</Button>
            </div>
            {answer === "no" && <p className="mt-3 text-sm">Open "Having trouble?" below, fix the sound, then play again.</p>}
          </div>
        )}
      </div>
    </Page>
  );
}

/* ---------------------------------------------------------------- 5. connection */

function NetworkStep({ onBack, onPass }: { onBack: () => void; onPass: (n: NetResult) => void }) {
  const [res, setRes] = useState<NetResult | null>(null);
  const [live, setLive] = useState<NetProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(() => {
    setRes(null); setError(null); setLive(null);
    measureConnection(setLive).then(setRes).catch((e) => { console.error("connection test:", e); setError("The connection test could not finish. Check you are online and not on a VPN, then test again."); });
  }, []);
  useEffect(run, [run]);
  const ok = !!res && res.downMbps >= MIN_DOWN && res.upMbps >= MIN_UP && res.latencyMs < MAX_LATENCY;
  const why = res && !ok ? [res.downMbps < MIN_DOWN && "download", res.upMbps < MIN_UP && "upload", res.latencyMs >= MAX_LATENCY && "latency"].filter(Boolean).join(", ") : "";
  const testing = !res && !error;
  const phase = live?.phase ?? "latency";
  const rows: { k: string; need: string; pass?: boolean; actual?: string; active: boolean }[] = [
    { k: "Download speed", need: `At least ${MIN_DOWN} Mbps`, pass: res ? res.downMbps >= MIN_DOWN : undefined, actual: res ? `${res.downMbps} Mbps` : undefined, active: testing && phase === "download" },
    { k: "Upload speed", need: `At least ${MIN_UP} Mbps`, pass: res ? res.upMbps >= MIN_UP : undefined, actual: res ? `${res.upMbps} Mbps` : undefined, active: testing && phase === "upload" },
    { k: "Response time", need: `Under ${MAX_LATENCY} ms`, pass: res ? res.latencyMs < MAX_LATENCY : undefined, actual: res ? `${res.latencyMs} ms` : undefined, active: testing && phase === "latency" },
  ];
  return (
    <Page title="Connection" intro="Your connection must meet the Pearson OnVUE minimums for the whole exam. Use your home network, not a VPN, office or public network."
      status={{ ok: res ? ok : error ? false : null, text: testing ? "Testing…" : ok ? "Meets the minimum" : error ? "Test failed" : `Too slow: ${why}` }}
      actions={<><Back onClick={onBack} /><Button variant="outline" onClick={run} disabled={testing}>Test again</Button><Button onClick={() => res && onPass(res)} disabled={!ok}>Next: screens</Button></>}
      help={[
        "Move closer to the Wi-Fi router or plug in an Ethernet cable.",
        "Pause downloads, cloud backups (iCloud, OneDrive, Google Drive), streaming and game updates on this and other devices.",
        "Turn off any VPN or proxy. Office and public Wi-Fi often block or slow exam traffic.",
        `A mobile hotspot works if it meets ${MIN_DOWN} Mbps down and ${MIN_UP} Mbps up here.`,
        "Speeds change from second to second. Run the test again after each fix.",
      ]}>
      <ul className="rounded-xl border border-line">
        {rows.map((r) => (
          <li key={r.k} className="flex items-center justify-between gap-4 border-b border-line px-4 py-3.5 last:border-0">
            <div><p className="font-semibold">{r.k}</p><p className="text-sm text-muted">{r.need}</p></div>
            <span className={cx("text-sm font-semibold", r.pass === true && "text-brand")}>
              {r.pass === undefined ? (r.active ? "Testing…" : "Waiting") : r.pass ? "Meets minimum" : `Only ${r.actual}`}
            </span>
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="mt-4 text-sm font-semibold">{error}</p>}
    </Page>
  );
}

/* ---------------------------------------------------------------- 6. screens */

function ScreensStep({ info, mac, refresh, onBack, onPass }: { info: SystemInfo | null; mac: boolean; refresh: () => Promise<SystemInfo>; onBack: () => void; onPass: (d: number) => void }) {
  const ok = info?.displays === 1;
  return (
    <Page title="Screens" intro="Only one screen may be connected. Unplug external monitors, TVs and projectors, and turn off screen mirroring."
      status={{ ok: info ? ok : null, text: !info ? "Checking…" : ok ? "One screen" : `${info.displays} screens found` }}
      actions={<><Back onClick={onBack} /><Button variant="outline" onClick={refresh}>Check again</Button><Button onClick={() => onPass(info!.displays)} disabled={!ok}>Next: computer</Button></>}
      help={[
        "Unplug the HDMI, USB-C or DisplayPort cable of every extra monitor, then click Check again.",
        mac ? "Turn off AirPlay and Sidecar in Control Centre, Screen Mirroring." : "Press Windows + P and choose PC screen only. Disconnect Miracast or wireless displays.",
        "Using a laptop with the lid closed and an external monitor is fine: that still counts as one screen.",
        "Virtual display apps (Duet, Spacedesk, BetterDisplay) count as screens. Quit them.",
      ]}>
      <ul className="grid gap-3 sm:grid-cols-3">
        {(info?.displayInfo || []).map((d, k) => (
          <li key={k} className="rounded-xl border border-line p-4 text-sm"><p className="font-semibold">Screen {k + 1}{d.internal ? " (built in)" : ""}</p><p className="text-muted">{d.w} × {d.h}</p></li>
        ))}
      </ul>
    </Page>
  );
}

/* ---------------------------------------------------------------- 7. computer */

function ComputerStep({ info, next, onBack, onPass }: { info: SystemInfo | null; next: string; onBack: () => void; onPass: () => void }) {
  const vm = info?.virtualMachine.length ?? 0;
  const ok = !!info && vm === 0 && !info.remoteSession;
  return (
    <Page title="Computer" intro="The exam must run on a real computer you are sitting at: no virtual machine, remote desktop or screen sharing."
      status={{ ok: info ? ok : null, text: !info ? "Checking…" : ok ? "Real computer" : "Not allowed" }}
      actions={<><Back onClick={onBack} /><Button onClick={onPass} disabled={!ok}>{next}</Button></>}
      help={[
        "Virtual machine found: install and run Yatri Proctor on the real computer, not inside VMware, VirtualBox, Parallels, UTM or a cloud PC.",
        "Remote session found: sit at the computer itself. Disconnect Remote Desktop, AnyDesk, TeamViewer or Chrome Remote Desktop and open the app locally.",
        "If you think this is wrong, email info@yatricloud.com with your computer model.",
      ]}>
      <ul className="space-y-2 text-[15px]">
        <li>Virtual machine: <span className="font-semibold">{vm ? `found (${info!.virtualMachine.join(", ")})` : "none"}</span></li>
        <li>Remote desktop session: <span className="font-semibold">{info?.remoteSession ? "yes" : "no"}</span></li>
        <li>System: <span className="font-semibold">{info?.os}</span></li>
      </ul>
    </Page>
  );
}

/* ---------------------------------------------------------------- 8. background apps */

function AppsStep({ info, refresh, next, busy: finishing, onBack, onPass }: { info: SystemInfo | null; refresh: () => Promise<SystemInfo>; next: string; busy: boolean; onBack: () => void; onPass: (apps: string[], skipped: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const apps = info?.blocked.map((b) => b.label) || [];
  const ok = !!info && apps.length === 0;
  async function close() { setBusy(true); await yp.closeApps(apps); await refresh(); setBusy(false); }
  return (
    <Page title="Background apps" intro="Meeting, chat, remote desktop, screen recording and AI assistant apps must be closed before the exam, and stay closed during it."
      status={{ ok: info ? ok : null, text: !info ? "Scanning…" : ok ? "All clear" : `${apps.length} app${apps.length > 1 ? "s" : ""} open` }}
      actions={<>
        <Back onClick={onBack} />
        {!ok && <Button onClick={close} disabled={busy}>{busy ? "Closing…" : "Close these apps"}</Button>}
        <Button variant="outline" onClick={() => { setBusy(true); refresh().finally(() => setBusy(false)); }} disabled={busy}>Scan again</Button>
        {ok ? <Button onClick={() => onPass([], false)} disabled={finishing}>{next}</Button> : <Button variant="ghost" onClick={() => onPass(apps, true)} disabled={finishing}>Skip for now (testing)</Button>}
      </>}
      help={[
        "Close these apps saves nothing in them. Save your work in those apps first.",
        "An app still listed after closing: quit it from the menu bar or system tray (right-click the icon, Quit). Some apps keep running in the background after the window closes.",
        info?.platform === "darwin" ? "Stubborn apps: press Option + Command + Esc, select the app, Force Quit." : "Stubborn apps: press Ctrl + Shift + Esc, select the app in Task Manager, End task.",
        "Turn off auto-start for chat and meeting apps so they do not reopen during the exam.",
      ]}>
      {apps.length > 0 ? (
        <ul className="grid gap-2 sm:grid-cols-2">
          {apps.map((a) => <li key={a} className="flex items-center justify-between rounded-xl border border-line px-4 py-3 text-[15px]"><span className="font-semibold">{a}</span><span className="text-sm text-muted">Running</span></li>)}
        </ul>
      ) : info && <p className="text-[15px]">No blocked apps are running.</p>}
      {!ok && <p className="mt-4 text-xs text-muted">Skipping is for testing only. It is recorded on your session and shown to the reviewer; the apps are still checked every 20 seconds during the exam.</p>}
    </Page>
  );
}

/* ---------------------------------------------------------------- 9. permissions (macOS) */

function PermissionsStep({ info, refresh, next, busy, onBack, onPass }: { info: SystemInfo | null; refresh: () => Promise<SystemInfo>; next: string; busy: boolean; onBack: () => void; onPass: () => void }) {
  const p = info?.permissions;
  const ok = p?.camera === "granted" && p?.microphone === "granted";
  const screenOk = p?.screen === "granted";
  useEffect(() => {
    // Settings changed in System Settings show up when the user comes back.
    const onFocus = () => { refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);
  const Row = ({ k, v, pane, optional }: { k: string; v?: string; pane: "camera" | "microphone" | "screen"; optional?: boolean }) => (
    <li className="flex items-center justify-between gap-4 border-b border-line py-3 last:border-0">
      <span className="font-semibold">{k}{optional && <span className="font-normal text-muted"> (optional)</span>}</span>
      <span className="flex items-center gap-3 text-sm">
        <span className={v === "granted" ? "font-semibold text-brand" : "font-semibold"}>{v === "granted" ? "Allowed" : "Not allowed"}</span>
        {v !== "granted" && <Button variant="outline" className="h-9" onClick={() => yp.openPrivacy(pane)}>Open settings</Button>}
      </span>
    </li>
  );
  return (
    <Page title="Permissions" intro="macOS asks you to allow Yatri Proctor to use the camera and microphone. Screen Recording lets it confirm your screen is not being shared."
      status={{ ok: info ? ok : null, text: ok ? "Allowed" : "Needs permission" }}
      actions={<><Back onClick={onBack} /><Button variant="outline" onClick={refresh}>Check again</Button><Button onClick={onPass} disabled={!ok || busy}>{next}</Button></>}
      help={[
        "Turned on but still says Not allowed: macOS applies privacy changes only after the app restarts. Click Quit and reopen; you come back to this page.",
        "Still not allowed after reopening: in System Settings, select Yatri Proctor in the list, click the minus (−) button to remove it, then click Allow screen recording here again and turn it on. This happens after an update, because each new version is a new app to macOS.",
        "Yatri Proctor is missing from the list: click Allow screen recording first. macOS adds the app the first time it asks.",
        "Camera or microphone not allowed: open settings, turn on Yatri Proctor, then Quit and reopen.",
      ]}>
      <ul><Row k="Camera" v={p?.camera} pane="camera" /><Row k="Microphone" v={p?.microphone} pane="microphone" /><Row k="Screen Recording" v={p?.screen} pane="screen" optional /></ul>
      {info && !screenOk && (
        <div className="mt-6 rounded-xl border border-line p-5">
          <p className="font-semibold">How to allow Screen Recording</p>
          <ol className="mt-3 space-y-4 text-[15px] leading-6">
            <li className="flex gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">1</span>
              <div>Ask macOS to add Yatri Proctor to the list.<div className="mt-2"><Button variant="outline" className="h-9" onClick={() => yp.requestScreen().then(() => refresh())}>Allow screen recording</Button></div></div></li>
            <li className="flex gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">2</span>
              <div>In System Settings, Privacy &amp; Security, Screen &amp; System Audio Recording, turn on <span className="font-semibold">Yatri Proctor</span>. Enter your Mac password if asked.<div className="mt-2"><Button variant="outline" className="h-9" onClick={() => yp.openPrivacy("screen")}>Open Screen Recording settings</Button></div></div></li>
            <li className="flex gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">3</span>
              <div>Restart Yatri Proctor so macOS applies it. Your progress is kept.<div className="mt-2"><Button className="h-9" onClick={() => yp.relaunch()}>Quit and reopen</Button></div></div></li>
          </ol>
        </div>
      )}
    </Page>
  );
}
