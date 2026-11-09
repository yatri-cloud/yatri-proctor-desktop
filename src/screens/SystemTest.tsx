import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Card, Shell, cx } from "../ui";
import { yp, type SystemInfo } from "../lib/bridge";
import { logEvent, supabase, type Session } from "../lib/api";
import { SUPABASE_KEY, SUPABASE_URL } from "../config";

/*
 * System test, one page per check (like Pearson OnVUE): devices, camera,
 * microphone, speaker, connection, screens, computer, background apps,
 * permissions (macOS), then a summary. Next unlocks only when the check on
 * the page passes. Background apps can be skipped for now; the skip is
 * recorded on the session and as a low-severity flag for the reviewer.
 */

export type CheckResults = {
  camera?: string; microphone?: string; speaker?: string;
  network?: { latencyMs: number; downMbps: number; upMbps: number };
  displays?: number; virtualMachine?: string[]; remoteSession?: boolean;
  blockedApps?: string[]; appsSkipped?: boolean; permissions?: SystemInfo["permissions"];
};

type StepKey = "devices" | "camera" | "mic" | "speaker" | "network" | "screens" | "computer" | "apps" | "permissions" | "summary";
const STEP_TITLES: Record<StepKey, string> = {
  devices: "Your devices", camera: "Camera", mic: "Microphone", speaker: "Speaker", network: "Connection",
  screens: "Screens", computer: "Computer", apps: "Background apps", permissions: "Permissions", summary: "Summary",
};
const MIN_DOWN = 6;
const MIN_UP = 2;

export default function SystemTest({ session, onPass }: { session: Session; onPass: (d: SystemInfo & { checks: CheckResults }, s: MediaStream) => void }) {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [camId, setCamId] = useState("");
  const [micId, setMicId] = useState("");
  const [spkId, setSpkId] = useState("");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [results, setResults] = useState<CheckResults>({});
  const [i, setI] = useState(0);

  const steps: StepKey[] = ["devices", "camera", "mic", "speaker", "network", "screens", "computer", "apps", ...(info?.platform === "darwin" ? ["permissions" as StepKey] : []), "summary"];
  const step = steps[i];
  const refresh = useCallback(async () => { const s = await yp.systemInfo(); setInfo(s); return s; }, []);

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
      setCamId(list.find((d) => d.kind === "videoinput")?.deviceId || "");
      setMicId(list.find((d) => d.kind === "audioinput")?.deviceId || "");
      setSpkId(list.find((d) => d.kind === "audiooutput")?.deviceId || "");
    })();
    const onChange = () => navigator.mediaDevices.enumerateDevices().then(setDevices);
    navigator.mediaDevices.addEventListener("devicechange", onChange);
    return () => navigator.mediaDevices.removeEventListener("devicechange", onChange);
  }, [refresh]);

  // One stream for the chosen camera + microphone, reopened when they change.
  useEffect(() => {
    if (!camId && !micId) return;
    let alive = true;
    let s: MediaStream | null = null;
    navigator.mediaDevices.getUserMedia({
      video: camId ? { deviceId: { exact: camId }, width: 1280, height: 720 } : true,
      audio: micId ? { deviceId: { exact: micId }, echoCancellation: false, noiseSuppression: false } : true,
    }).then((st) => { if (!alive) { st.getTracks().forEach((t) => t.stop()); return; } s = st; setStream(st); setMediaError(null); })
      .catch((e) => setMediaError((e as Error).name === "NotAllowedError" ? "Camera or microphone access is blocked." : "This camera or microphone cannot be opened. Choose another one."));
    return () => { alive = false; s?.getTracks().forEach((t) => t.stop()); };
  }, [camId, micId]);

  const save = (patch: CheckResults) => setResults((r) => ({ ...r, ...patch }));
  const next = () => setI((k) => Math.min(k + 1, steps.length - 1));
  const back = () => setI((k) => Math.max(k - 1, 0));
  const label = (id: string, kind: MediaDeviceKind) => devices.find((d) => d.deviceId === id && d.kind === kind)?.label || "Default";

  async function finish() {
    if (!info || !stream) return;
    if (results.appsSkipped) {
      await logEvent(session.id, { kind: "blocked_app", severity: 1, detail: { skipped_at_system_test: true, apps: results.blockedApps } });
    }
    await supabase.auth.refreshSession();
    onPass({ ...info, checks: results }, stream);
  }

  return (
    <Shell step={0} title="System test" subtitle={`${session.exam_code || "Your exam"} · Use the same computer, room and network for the whole exam.`}>
      <div className="max-w-4xl">
        <ol aria-label="System test steps" className="mb-6 flex flex-wrap gap-1.5">
          {steps.map((s, k) => (
            <li key={s} className={cx("flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium",
              k === i ? "border-brand bg-brand text-white" : k < i ? "border-ink/20 text-ink" : "border-line text-muted")}>
              {k < i ? "✓" : k + 1} {STEP_TITLES[s]}
            </li>
          ))}
        </ol>

        {step === "devices" && (
          <DevicesStep info={info} devices={devices} camId={camId} micId={micId} spkId={spkId} setCamId={setCamId} setMicId={setMicId} setSpkId={setSpkId}
            error={mediaError} onNext={next} />
        )}
        {step === "camera" && <CameraStep stream={stream} error={mediaError} onBack={back} onPass={() => { save({ camera: label(camId, "videoinput") }); next(); }} />}
        {step === "mic" && <MicStep stream={stream} onBack={back} onPass={() => { save({ microphone: label(micId, "audioinput") }); next(); }} />}
        {step === "speaker" && <SpeakerStep sinkId={spkId} onBack={back} onPass={() => { save({ speaker: label(spkId, "audiooutput") }); next(); }} />}
        {step === "network" && <NetworkStep onBack={back} onPass={(n) => { save({ network: n }); next(); }} />}
        {step === "screens" && <ScreensStep info={info} refresh={refresh} onBack={back} onPass={(d) => { save({ displays: d }); next(); }} />}
        {step === "computer" && <ComputerStep info={info} onBack={back} onPass={() => { save({ virtualMachine: info?.virtualMachine, remoteSession: info?.remoteSession }); next(); }} />}
        {step === "apps" && <AppsStep info={info} refresh={refresh} onBack={back} onPass={(apps, skipped) => { save({ blockedApps: apps, appsSkipped: skipped }); next(); }} />}
        {step === "permissions" && <PermissionsStep info={info} refresh={refresh} onBack={back} onPass={() => { save({ permissions: info?.permissions }); next(); }} />}
        {step === "summary" && <SummaryStep results={results} info={info} onBack={back} onFinish={finish} />}
      </div>
    </Shell>
  );
}

/* ---------------------------------------------------------------- page frame */

function Page({ title, intro, status, children, actions }: { title: string; intro: ReactNode; status?: { ok: boolean | null; text: string }; children?: ReactNode; actions: ReactNode }) {
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
      <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-line pt-6">{actions}</div>
    </Card>
  );
}

const Back = ({ onClick }: { onClick: () => void }) => <Button variant="ghost" onClick={onClick}>Back</Button>;

/* ---------------------------------------------------------------- 1. devices */

function DevicesStep(p: {
  info: SystemInfo | null; devices: MediaDeviceInfo[]; camId: string; micId: string; spkId: string;
  setCamId: (v: string) => void; setMicId: (v: string) => void; setSpkId: (v: string) => void; error: string | null; onNext: () => void;
}) {
  const cams = p.devices.filter((d) => d.kind === "videoinput");
  const mics = p.devices.filter((d) => d.kind === "audioinput");
  const spks = p.devices.filter((d) => d.kind === "audiooutput");
  const ok = cams.length > 0 && mics.length > 0 && !p.error;
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
      actions={<Button onClick={p.onNext} disabled={!ok}>Next: camera</Button>}>
      <div className="grid gap-4 sm:grid-cols-3">
        <Select id="cam" label="Camera" value={p.camId} list={cams} onChange={p.setCamId} />
        <Select id="mic" label="Microphone" value={p.micId} list={mics} onChange={p.setMicId} />
        <Select id="spk" label="Speaker" value={p.spkId} list={spks} onChange={p.setSpkId} />
      </div>
      {p.error && <p role="alert" className="mt-4 text-sm font-semibold">{p.error} {p.info?.platform === "darwin" && <button className="underline" onClick={() => yp.openPrivacy("camera")}>Open camera settings</button>}</p>}
      {p.info && (
        <dl className="mt-6 grid gap-x-6 gap-y-3 rounded-xl border border-line p-4 text-sm sm:grid-cols-2">
          {[["System", p.info.os], ["Processor", p.info.cpu], ["Memory", `${p.info.memoryGb} GB`],
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

function CameraStep({ stream, error, onBack, onPass }: { stream: MediaStream | null; error: string | null; onBack: () => void; onPass: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [signal, setSignal] = useState<"wait" | "ok" | "dark">("wait");
  useEffect(() => {
    if (!video.current || !stream) return;
    video.current.srcObject = stream;
    video.current.play().catch(() => {});
    // Automatic check: the picture is not black (covered lens, wrong camera).
    const t = setInterval(() => {
      const v = video.current;
      if (!v || v.readyState < 2) return;
      const c = document.createElement("canvas");
      c.width = 32; c.height = 18;
      const g = c.getContext("2d")!;
      g.drawImage(v, 0, 0, 32, 18);
      const d = g.getImageData(0, 0, 32, 18).data;
      let sum = 0; for (let k = 0; k < d.length; k += 4) sum += d[k] + d[k + 1] + d[k + 2];
      setSignal(sum / (d.length / 4) / 3 > 18 ? "ok" : "dark");
    }, 700);
    return () => clearInterval(t);
  }, [stream]);
  return (
    <Page title="Camera" intro="Sit where you will take the exam. Your whole face should be visible, well lit from the front, with nothing covering the camera."
      status={{ ok: error ? false : signal === "ok" ? true : signal === "dark" ? false : null, text: error ? "No camera" : signal === "ok" ? "Picture received" : signal === "dark" ? "Picture too dark" : "Starting…" }}
      actions={<><Back onClick={onBack} /><Button onClick={onPass} disabled={signal !== "ok"}>Yes, I can see myself clearly</Button></>}>
      <div className="mx-auto max-w-xl overflow-hidden rounded-2xl bg-ink">
        <video ref={video} muted playsInline className="aspect-video w-full -scale-x-100 object-cover" />
      </div>
      {signal === "dark" && <p className="mt-3 text-center text-sm font-semibold">The picture is dark. Uncover the camera, add light, or choose another camera on the previous page.</p>}
    </Page>
  );
}

/* ---------------------------------------------------------------- 3. microphone */

function MicStep({ stream, onBack, onPass }: { stream: MediaStream | null; onBack: () => void; onPass: () => void }) {
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState(0);
  useEffect(() => {
    if (!stream) return;
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(new ArrayBuffer(an.fftSize * 4));
    let raf = 0;
    const loop = () => {
      an.getFloatTimeDomainData(buf);
      let s = 0; for (const v of buf) s += v * v;
      const rms = Math.sqrt(s / buf.length);
      setLevel(rms);
      if (rms > 0.04) setHeard((h) => Math.min(100, h + 2));
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => { cancelAnimationFrame(raf); ctx.close().catch(() => {}); };
  }, [stream]);
  const ok = heard >= 100;
  return (
    <Page title="Microphone" intro={<>Say this out loud at a normal volume: <span className="font-semibold text-ink">"My name is … and I am ready for my exam."</span></>}
      status={{ ok: ok ? true : null, text: ok ? "We can hear you" : heard > 0 ? "Keep talking…" : "Listening…" }}
      actions={<><Back onClick={onBack} /><Button onClick={onPass} disabled={!ok}>Next: speaker</Button></>}>
      <div className="mx-auto max-w-xl">
        <p className="text-sm text-muted">Input level</p>
        <div className="mt-2 flex h-10 items-end gap-1" aria-hidden="true">
          {Array.from({ length: 32 }, (_, k) => (
            <span key={k} className={cx("flex-1 rounded-sm transition-[height]", k / 32 < Math.min(1, level * 9) ? "bg-brand" : "bg-line")} style={{ height: `${30 + ((k * 37) % 70)}%` }} />
          ))}
        </div>
        <div className="mt-6 h-2 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-ink transition-[width]" style={{ width: `${heard}%` }} /></div>
        <p className="mt-2 text-xs text-muted">Speech heard: {heard}%</p>
      </div>
    </Page>
  );
}

/* ---------------------------------------------------------------- 4. speaker */

function SpeakerStep({ sinkId, onBack, onPass }: { sinkId: string; onBack: () => void; onPass: () => void }) {
  const [played, setPlayed] = useState(false);
  const [answer, setAnswer] = useState<"yes" | "no" | null>(null);
  async function play() {
    // A short two-note chime, routed to the chosen speaker when supported.
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
    if (sinkId && sink.setSinkId) await sink.setSinkId(sinkId).catch(() => {});
    await audio.play().catch(() => {});
    setTimeout(() => { audio.pause(); ctx.close().catch(() => {}); }, 1400);
    setPlayed(true);
    setAnswer(null);
  }
  return (
    <Page title="Speaker" intro="Turn your volume up and play the test sound. Headphones and earbuds are not allowed during the exam, so use the computer's speakers."
      status={{ ok: answer === "yes" ? true : answer === "no" ? false : null, text: answer === "yes" ? "Sound works" : answer === "no" ? "Not heard" : "Not tested" }}
      actions={<><Back onClick={onBack} /><Button onClick={onPass} disabled={answer !== "yes"}>Next: connection</Button></>}>
      <div className="mx-auto flex max-w-xl flex-col items-center gap-5 text-center">
        <Button variant="outline" onClick={play}>{played ? "Play again" : "Play test sound"}</Button>
        {played && (
          <div>
            <p className="font-semibold">Did you hear the sound?</p>
            <div className="mt-3 flex justify-center gap-3">
              <Button onClick={() => setAnswer("yes")} variant={answer === "yes" ? "primary" : "outline"}>Yes</Button>
              <Button onClick={() => setAnswer("no")} variant={answer === "no" ? "primary" : "outline"}>No</Button>
            </div>
            {answer === "no" && <p className="mt-3 text-sm">Check the volume and mute, or choose another speaker on the first page, then play again.</p>}
          </div>
        )}
      </div>
    </Page>
  );
}

/* ---------------------------------------------------------------- 5. connection */

async function measure(): Promise<{ latencyMs: number; downMbps: number; upMbps: number }> {
  const pings: number[] = [];
  for (let k = 0; k < 4; k++) {
    const t = performance.now();
    await fetch(`${SUPABASE_URL}/auth/v1/health`, { cache: "no-store", headers: { apikey: SUPABASE_KEY } });
    pings.push(performance.now() - t);
  }
  const bytes = 4_000_000;
  let t = performance.now();
  const r = await fetch(`https://speed.cloudflare.com/__down?bytes=${bytes}`, { cache: "no-store" });
  await r.arrayBuffer();
  const downMbps = (bytes * 8) / ((performance.now() - t) / 1000) / 1e6;
  const up = new Uint8Array(1_000_000);
  t = performance.now();
  await fetch("https://speed.cloudflare.com/__up", { method: "POST", body: up });
  const upMbps = (up.length * 8) / ((performance.now() - t) / 1000) / 1e6;
  return { latencyMs: Math.round(pings.sort((a, b) => a - b)[1]), downMbps: Math.round(downMbps * 10) / 10, upMbps: Math.round(upMbps * 10) / 10 };
}

function NetworkStep({ onBack, onPass }: { onBack: () => void; onPass: (n: { latencyMs: number; downMbps: number; upMbps: number }) => void }) {
  const [res, setRes] = useState<{ latencyMs: number; downMbps: number; upMbps: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(() => { setRes(null); setError(null); measure().then(setRes).catch(() => setError("The connection test failed. Check you are online and not on a VPN.")); }, []);
  useEffect(run, [run]);
  const ok = !!res && res.downMbps >= MIN_DOWN && res.upMbps >= MIN_UP && res.latencyMs < 800;
  const Stat = ({ k, v, need }: { k: string; v: string; need: string }) => (
    <div className="rounded-xl border border-line p-4 text-center"><p className="text-xs text-muted">{k}</p><p className="mt-1 font-display text-2xl font-bold tabular-nums">{v}</p><p className="text-xs text-muted">{need}</p></div>
  );
  return (
    <Page title="Connection" intro="A stable connection keeps your exam and monitoring running. Use your home network, not a VPN, office or public network."
      status={{ ok: res ? ok : error ? false : null, text: !res && !error ? "Testing…" : ok ? "Connection is good" : "Too slow or unstable" }}
      actions={<><Back onClick={onBack} /><Button variant="outline" onClick={run}>Test again</Button><Button onClick={() => res && onPass(res)} disabled={!ok}>Next: screens</Button></>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat k="Download" v={res ? `${res.downMbps} Mbps` : "…"} need={`Needs ${MIN_DOWN} Mbps`} />
        <Stat k="Upload" v={res ? `${res.upMbps} Mbps` : "…"} need={`Needs ${MIN_UP} Mbps`} />
        <Stat k="Latency" v={res ? `${res.latencyMs} ms` : "…"} need="Under 800 ms" />
      </div>
      {error && <p role="alert" className="mt-4 text-sm font-semibold">{error}</p>}
    </Page>
  );
}

/* ---------------------------------------------------------------- 6. screens */

function ScreensStep({ info, refresh, onBack, onPass }: { info: SystemInfo | null; refresh: () => Promise<SystemInfo>; onBack: () => void; onPass: (d: number) => void }) {
  const ok = info?.displays === 1;
  return (
    <Page title="Screens" intro="Only one screen may be connected. Unplug external monitors, TVs and projectors, and turn off screen mirroring."
      status={{ ok: info ? ok : null, text: !info ? "Checking…" : ok ? "One screen" : `${info.displays} screens found` }}
      actions={<><Back onClick={onBack} /><Button variant="outline" onClick={refresh}>Check again</Button><Button onClick={() => onPass(info!.displays)} disabled={!ok}>Next: computer</Button></>}>
      <ul className="grid gap-3 sm:grid-cols-3">
        {(info?.displayInfo || []).map((d, k) => (
          <li key={k} className="rounded-xl border border-line p-4 text-sm"><p className="font-semibold">Screen {k + 1}{d.internal ? " (built in)" : ""}</p><p className="text-muted">{d.w} × {d.h}</p></li>
        ))}
      </ul>
    </Page>
  );
}

/* ---------------------------------------------------------------- 7. computer */

function ComputerStep({ info, onBack, onPass }: { info: SystemInfo | null; onBack: () => void; onPass: () => void }) {
  const vm = info?.virtualMachine.length ?? 0;
  const ok = !!info && vm === 0 && !info.remoteSession;
  return (
    <Page title="Computer" intro="The exam must run on a real computer you are sitting at: no virtual machine, remote desktop or screen sharing."
      status={{ ok: info ? ok : null, text: !info ? "Checking…" : ok ? "Real computer" : "Not allowed" }}
      actions={<><Back onClick={onBack} /><Button onClick={onPass} disabled={!ok}>Next: background apps</Button></>}>
      <ul className="space-y-2 text-[15px]">
        <li>Virtual machine: <span className="font-semibold">{vm ? `found (${info!.virtualMachine.join(", ")})` : "none"}</span></li>
        <li>Remote desktop session: <span className="font-semibold">{info?.remoteSession ? "yes" : "no"}</span></li>
        <li>System: <span className="font-semibold">{info?.os}</span></li>
      </ul>
    </Page>
  );
}

/* ---------------------------------------------------------------- 8. background apps */

function AppsStep({ info, refresh, onBack, onPass }: { info: SystemInfo | null; refresh: () => Promise<SystemInfo>; onBack: () => void; onPass: (apps: string[], skipped: boolean) => void }) {
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
        {ok ? <Button onClick={() => onPass([], false)}>Next</Button> : <Button variant="ghost" onClick={() => onPass(apps, true)}>Skip for now (testing)</Button>}
      </>}>
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

function PermissionsStep({ info, refresh, onBack, onPass }: { info: SystemInfo | null; refresh: () => Promise<SystemInfo>; onBack: () => void; onPass: () => void }) {
  const p = info?.permissions;
  const ok = p?.camera === "granted" && p?.microphone === "granted";
  const Row = ({ k, v, pane, optional }: { k: string; v?: string; pane: "camera" | "microphone" | "screen"; optional?: boolean }) => (
    <li className="flex items-center justify-between gap-4 border-b border-line py-3 last:border-0">
      <span className="font-semibold">{k}{optional && <span className="font-normal text-muted"> (optional)</span>}</span>
      <span className="flex items-center gap-3 text-sm">{v === "granted" ? "Allowed" : "Not allowed"}{v !== "granted" && <Button variant="outline" className="h-9" onClick={() => yp.openPrivacy(pane)}>Open settings</Button>}</span>
    </li>
  );
  return (
    <Page title="Permissions" intro="macOS asks you to allow Yatri Proctor to use the camera and microphone. Screen Recording lets it check that your screen is not shared; after allowing it, quit and reopen the app."
      status={{ ok: info ? ok : null, text: ok ? "Allowed" : "Needs permission" }}
      actions={<><Back onClick={onBack} /><Button variant="outline" onClick={refresh}>Check again</Button><Button onClick={onPass} disabled={!ok}>Next: summary</Button></>}>
      <ul><Row k="Camera" v={p?.camera} pane="camera" /><Row k="Microphone" v={p?.microphone} pane="microphone" /><Row k="Screen Recording" v={p?.screen} pane="screen" optional /></ul>
    </Page>
  );
}

/* ---------------------------------------------------------------- 10. summary */

function SummaryStep({ results, info, onBack, onFinish }: { results: CheckResults; info: SystemInfo | null; onBack: () => void; onFinish: () => void }) {
  const [busy, setBusy] = useState(false);
  const rows: [string, string, boolean][] = [
    ["Camera", results.camera || "", !!results.camera],
    ["Microphone", results.microphone || "", !!results.microphone],
    ["Speaker", results.speaker || "", !!results.speaker],
    ["Connection", results.network ? `${results.network.downMbps} Mbps down · ${results.network.upMbps} up · ${results.network.latencyMs} ms` : "", !!results.network],
    ["Screens", results.displays != null ? `${results.displays}` : "", results.displays === 1],
    ["Computer", info?.virtualMachine.length || info?.remoteSession ? "Not allowed" : "Real computer", !info?.virtualMachine.length && !info?.remoteSession],
    ["Background apps", results.appsSkipped ? `Skipped (${results.blockedApps?.join(", ")})` : "All clear", true],
  ];
  return (
    <Page title="System test complete" intro="This computer is ready. Next is check-in: a photo of you, your ID and your room."
      status={{ ok: true, text: "Passed" }}
      actions={<><Back onClick={onBack} /><Button onClick={() => { setBusy(true); onFinish(); }} disabled={busy}>{busy ? "Preparing…" : "Continue to check-in"}</Button></>}>
      <table className="w-full text-[15px]">
        <tbody>
          {rows.map(([k, v, ok]) => (
            <tr key={k} className="border-b border-line last:border-0">
              <td className="py-3 font-semibold">{k}</td>
              <td className="py-3 text-muted">{v}</td>
              <td className="py-3 text-right font-semibold">{ok ? "Passed" : "Check"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Page>
  );
}
