import { useEffect, useState } from "react";
import { yp, type SystemInfo } from "./lib/bridge";
import { getSession, supabase, type Session } from "./lib/api";
import Launch from "./screens/Launch";
import Consent from "./screens/Consent";
import SystemTest from "./screens/SystemTest";
import CheckIn from "./screens/CheckIn";
import Ready from "./screens/Ready";
import Exam from "./screens/Exam";
import Results from "./screens/Results";

type Stage = "launch" | "consent" | "system" | "checkin" | "ready" | "exam" | "results";
const STORE = "yp-active-session";

/*
 * Yatri Proctor flow, modelled on Pearson OnVUE:
 * launch (code from yatricloud.com) -> consent -> system test -> check-in
 * (headshot, ID, room) -> rules -> locked exam -> results.
 * A crash or reboot resumes the same session (answers are autosaved).
 */
export default function App() {
  const [stage, setStage] = useState<Stage>("launch");
  const [session, setSession] = useState<Session | null>(null);
  const [device, setDevice] = useState<SystemInfo | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);

  // Resume an unfinished session after a restart.
  useEffect(() => {
    const saved = localStorage.getItem(STORE);
    if (!saved) return;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!data.session) return;
      try {
        const s = await getSession(saved);
        if (s.submitted_at) { localStorage.removeItem(STORE); return; }
        setSession(s);
        setStage("consent");
      } catch { localStorage.removeItem(STORE); }
    });
  }, []);

  const started = (s: Session) => { localStorage.setItem(STORE, s.id); setSession(s); setStage("consent"); };
  const finished = (s: Session) => { localStorage.removeItem(STORE); stream?.getTracks().forEach((t) => t.stop()); setStream(null); setSession(s); setStage("results"); };

  if (stage === "launch" || !session) return <Launch onReady={started} />;
  if (stage === "consent") return <Consent session={session} onAccept={() => setStage("system")} onDecline={() => { localStorage.removeItem(STORE); yp.quit(); }} />;
  if (stage === "system") return <SystemTest session={session} onPass={(d, s) => { setDevice(d); setStream(s); setStage("checkin"); }} />;
  if (stage === "checkin") return <CheckIn session={session} device={device} stream={stream!} onDone={() => setStage("ready")} />;
  if (stage === "ready") return <Ready session={session} onStart={() => setStage("exam")} />;
  if (stage === "exam") return <Exam initial={session} stream={stream!} onFinished={finished} />;
  return <Results session={session} />;
}
