import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, CheckRow, Shell } from "../ui";
import { yp, type SystemInfo } from "../lib/bridge";
import { supabase, type Session } from "../lib/api";
import { SUPABASE_KEY, SUPABASE_URL } from "../config";

/*
 * System test (like OnVUE): camera, microphone, connection, one screen, no
 * virtual machine or remote session, blocked apps closed, OS permissions.
 * Continue unlocks only when every required check passes.
 */
export default function SystemTest({ session, onPass }: { session: Session; onPass: (d: SystemInfo, s: MediaStream) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState(false);
  const [net, setNet] = useState<{ ms: number; ok: boolean } | null>(null);
  const [closing, setClosing] = useState(false);

  const refresh = useCallback(async () => setInfo(await yp.systemInfo()), []);

  useEffect(() => {
    let stop = false;
    let raf = 0;
    (async () => {
      await yp.askMedia();
      await refresh();
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: { echoCancellation: false, noiseSuppression: false } });
        if (stop) { s.getTracks().forEach((t) => t.stop()); return; }
        setStream(s);
        if (video.current) { video.current.srcObject = s; await video.current.play().catch(() => {}); }
        const ctx = new AudioContext();
        const an = ctx.createAnalyser();
        ctx.createMediaStreamSource(s).connect(an);
        const buf = new Float32Array(new ArrayBuffer(an.fftSize * 4));
        const loop = () => {
          an.getFloatTimeDomainData(buf);
          let sum = 0; for (const v of buf) sum += v * v;
          const rms = Math.sqrt(sum / buf.length);
          setLevel(rms);
          if (rms > 0.04) setHeard(true);
          raf = requestAnimationFrame(loop);
        };
        loop();
      } catch (e) {
        setCamError((e as Error).name === "NotAllowedError" ? "Camera or microphone access is blocked." : "No camera or microphone found.");
      }
      // Connection: three round trips to the exam server.
      const times: number[] = [];
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        try { await fetch(`${SUPABASE_URL}/auth/v1/health`, { cache: "no-store", headers: { apikey: SUPABASE_KEY } }); times.push(performance.now() - t); } catch { /* offline */ }
      }
      const ms = times.length ? Math.round(times.reduce((a, b) => a + b) / times.length) : 0;
      if (!stop) setNet({ ms, ok: times.length === 3 && ms < 1500 });
    })();
    return () => { stop = true; cancelAnimationFrame(raf); };
  }, [refresh]);

  async function closeApps() {
    if (!info) return;
    setClosing(true);
    await yp.closeApps(info.blocked.map((b) => b.label));
    await refresh();
    setClosing(false);
  }

  const mac = info?.platform === "darwin";
  const camOk = !!stream && !camError;
  const checks = {
    camera: camOk,
    mic: camOk && heard,
    network: !!net?.ok,
    displays: (info?.displays ?? 0) === 1,
    vm: !!info && info.virtualMachine.length === 0,
    remote: !!info && !info.remoteSession,
    apps: !!info && info.blocked.length === 0,
  };
  const allOk = Object.values(checks).every(Boolean);

  return (
    <Shell step={0} title="System test" subtitle={`Checking this computer for ${session.exam_code || "your exam"}. Use the same computer, room and network for the whole exam.`}>
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <Card>
          <ul>
            <CheckRow label="Camera" status={camError ? "fail" : camOk ? "pass" : "wait"}
              detail={camError || "Your face should be clearly visible and well lit."}
              action={camError && mac ? <Button variant="outline" onClick={() => yp.openPrivacy("camera")}>Open camera settings</Button> : undefined} />
            <CheckRow label="Microphone" status={!camOk ? (camError ? "fail" : "wait") : heard ? "pass" : "warn"}
              detail={heard ? "We can hear you." : "Say your name out loud so we can hear you."}
              action={<div className="h-2 w-64 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${Math.min(100, level * 900)}%` }} /></div>} />
            <CheckRow label="Connection" status={!net ? "wait" : net.ok ? "pass" : "fail"}
              detail={!net ? "Testing…" : net.ok ? `Stable, about ${net.ms} ms to the exam server.` : "Unstable or offline. Use a stable home network, no VPN."} />
            <CheckRow label="One screen only" status={!info ? "wait" : checks.displays ? "pass" : "fail"}
              detail={info && !checks.displays ? `${info.displays} screens found. Unplug the extra screens, then recheck.` : "Only this screen may be connected."}
              action={info && !checks.displays ? <Button variant="outline" onClick={refresh}>Recheck</Button> : undefined} />
            <CheckRow label="Real computer" status={!info ? "wait" : checks.vm && checks.remote ? "pass" : "fail"}
              detail={info && (!checks.vm || !checks.remote) ? (info.remoteSession ? "This is a remote desktop session. Sit at the computer itself." : `This looks like a virtual machine (${info.virtualMachine[0]}). Use a real computer.`) : "No virtual machine or remote desktop."} />
            <CheckRow label="Other apps closed" status={!info ? "wait" : checks.apps ? "pass" : "fail"}
              detail={info && !checks.apps ? <>Close these apps: <span className="font-semibold text-ink">{info.blocked.map((b) => b.label).join(", ")}</span></> : "Meeting, remote desktop, recording and AI assistant apps must be closed."}
              action={info && !checks.apps ? <div className="flex gap-2"><Button onClick={closeApps} disabled={closing}>{closing ? "Closing…" : "Close these apps"}</Button><Button variant="outline" onClick={refresh}>Recheck</Button></div> : undefined} />
            {mac && (
              <CheckRow label="Screen Recording permission" status={info?.permissions.screen === "granted" ? "pass" : "warn"}
                detail="Optional. Lets Yatri Proctor check that your screen is not shared."
                action={info?.permissions.screen !== "granted" ? <Button variant="outline" onClick={() => yp.openPrivacy("screen")}>Open settings</Button> : undefined} />
            )}
          </ul>
        </Card>
        <div className="space-y-4">
          <div className="overflow-hidden rounded-2xl border border-line bg-ink">
            <video ref={video} muted playsInline className="aspect-video w-full -scale-x-100 object-cover" />
          </div>
          {info && <p className="text-xs text-muted">{info.os} · {info.cpu} · {info.memoryGb} GB · Yatri Proctor {info.appVersion}</p>}
          <Button className="w-full" disabled={!allOk || !info || !stream} onClick={async () => { await supabase.auth.refreshSession(); onPass(info!, stream!); }}>
            {allOk ? "Continue to check-in" : "Fix the checks above"}
          </Button>
        </div>
      </div>
    </Shell>
  );
}
