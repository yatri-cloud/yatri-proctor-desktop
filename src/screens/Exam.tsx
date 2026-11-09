import { useCallback, useEffect, useRef, useState } from "react";
import { Button, cx } from "../ui";
import { yp } from "../lib/bridge";
import { beginExam, saveAnswers, submit, type Session } from "../lib/api";
import { faceModel, Monitor, type Live } from "../lib/monitor";

const LETTER = (i: number) => String.fromCharCode(65 + i);

/*
 * The locked exam. Enters lockdown (kiosk, always on top, content
 * protection), starts the exam clock and AI monitoring, autosaves answers,
 * and submits on Submit, when time runs out, or when the learner confirms
 * quitting. Lockdown is released only after submit.
 */
export default function Exam({ initial, stream, onFinished }: { initial: Session; stream: MediaStream; onFinished: (s: Session) => void }) {
  const qs = initial.questions;
  const cam = useRef<HTMLVideoElement>(null);
  const monitor = useRef<Monitor | null>(null);
  const done = useRef(false);
  const [i, setI] = useState(() => Math.max(0, qs.findIndex((q) => !(initial.answers[q.id] || []).length)));
  const [answers, setAnswers] = useState<Record<string, number[]>>(initial.answers || {});
  const [marked, setMarked] = useState<string[]>(initial.marked || []);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [live, setLive] = useState<Live | null>(null);
  const [board, setBoard] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const q = qs[i];
  const chosen = answers[q.id] || [];
  const need = q.multi ? 2 : 1;
  const answered = qs.filter((x) => (answers[x.id] || []).length).length;
  const left = startedAt && initial.duration_sec ? Math.max(0, Math.floor((startedAt + initial.duration_sec * 1000 - now) / 1000)) : null;

  const finish = useCallback(async () => {
    if (done.current) return;
    done.current = true;
    setSubmitting(true);
    try {
      await monitor.current?.stop();
      const result = await submit(initial.id, answers, marked);
      await yp.lockdown(false);
      onFinished(result);
    } catch (e) {
      done.current = false;
      setSubmitting(false);
      setError(`${(e as Error).message} Your answers are saved; try Submit again.`);
    }
  }, [answers, marked, initial.id, onFinished]);

  // Lockdown, clock and monitoring.
  useEffect(() => {
    let off: (() => void) | undefined;
    let offClose: (() => void) | undefined;
    (async () => {
      await yp.lockdown(true);
      const t = await beginExam(initial.id).catch(() => initial.started_at);
      setStartedAt(new Date(t).getTime());
      if (cam.current) { cam.current.srcObject = stream; await cam.current.play().catch(() => {}); }
      try {
        const model = await faceModel();
        monitor.current = new Monitor(initial.id, cam.current!, stream, model, setLive);
        monitor.current.start();
      } catch {
        setError("AI monitoring could not start on this computer. Your exam continues and the session will be reviewed.");
      }
      off = yp.onEvent((e) => monitor.current?.fromMain(e));
      offClose = yp.onCloseRequested(async () => { if (await yp.confirmQuit()) finish(); });
    })();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(tick); off?.(); offClose?.(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (left === 0) finish(); }, [left, finish]);

  // Autosave (debounced).
  useEffect(() => {
    const t = setTimeout(() => { if (!done.current) saveAnswers(initial.id, answers, marked).catch(() => {}); }, 800);
    return () => clearTimeout(t);
  }, [answers, marked, initial.id]);

  const pick = useCallback((k: number) => setAnswers((a) => {
    const cur = a[q.id] || [];
    const next = q.multi ? (cur.includes(k) ? cur.filter((x) => x !== k) : cur.length >= need ? [...cur.slice(1), k] : [...cur, k]) : [k];
    return { ...a, [q.id]: next };
  }), [q, need]);
  const toggleMark = useCallback(() => setMarked((m) => (m.includes(q.id) ? m.filter((x) => x !== q.id) : [...m, q.id])), [q.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("textarea, input")) return;
      const k = e.key.toLowerCase();
      const idx = /^[1-6]$/.test(k) ? Number(k) - 1 : /^[a-f]$/.test(k) ? k.charCodeAt(0) - 97 : -1;
      if (idx >= 0 && idx < q.options.length) pick(idx);
      else if (k === "arrowright" && i < qs.length - 1) setI(i + 1);
      else if (k === "arrowleft" && i > 0) setI(i - 1);
      else if (k === "m") toggleMark();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [i, q, qs.length, pick, toggleMark]);

  const status = !live ? "Starting camera…" : live.faces === 0 ? "We cannot see your face" : live.faces > 1 ? "More than one person in view" : live.lookingAway ? "Please look at the screen" : live.voice ? "Voice detected" : "You are in view";
  const okStatus = live && live.faces === 1 && !live.lookingAway && !live.voice;

  return (
    <div className="flex h-full flex-col bg-white">
      <header className="flex h-16 shrink-0 items-center gap-4 border-b border-line px-6">
        {initial.badge_url && <img src={initial.badge_url} alt="" className="h-9 w-9 object-contain" />}
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{initial.cert_label.replace(/^[A-Z]{2,5}-\d{2,4}:\s*/, "")}</p>
          <p className="text-xs text-muted">{initial.exam_code} · Proctored mock exam</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className={cx("flex items-center gap-2 rounded-xl border px-2 py-1", okStatus ? "border-line" : "border-ink")}>
            <video ref={cam} muted playsInline className="h-9 w-14 -scale-x-100 rounded-md bg-ink object-cover" />
            <span className="w-44 text-xs font-medium" aria-live="polite">{status}</span>
          </div>
          {left !== null && <span className={cx("rounded-xl border px-3 py-2 font-mono text-sm font-semibold tabular-nums", left < 300 ? "border-ink" : "border-line")} aria-label="Time left">{Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</span>}
          <Button variant="outline" className="h-10" onClick={() => setBoard(!board)}>{board ? "Hide whiteboard" : "Whiteboard"}</Button>
          <Button className="h-10" onClick={() => setConfirm(true)} disabled={submitting}>{submitting ? "Submitting…" : "Submit exam"}</Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-y-auto px-8 py-8">
          <div className="mx-auto max-w-3xl">
            <div className="flex justify-between text-sm text-muted">
              <span className="tabular-nums">Question {i + 1} of {qs.length}</span>
              <span>{initial.domains?.find((d) => d.key === q.domain_key)?.name}</span>
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${(answered / qs.length) * 100}%` }} /></div>
            <fieldset className="mt-8">
              <legend className="text-xl font-semibold leading-relaxed">{q.stem}</legend>
              {q.multi && <p className="mt-2 text-sm text-muted">Choose two.</p>}
              <div className="mt-6 space-y-3">
                {q.options.map((o, k) => {
                  const on = chosen.includes(k);
                  return (
                    <button key={k} type="button" role={q.multi ? "checkbox" : "radio"} aria-checked={on} onClick={() => pick(k)}
                      className={cx("flex min-h-[52px] w-full items-start gap-4 rounded-xl border px-4 py-3.5 text-left text-[15px] transition-colors", on ? "border-ink ring-1 ring-ink" : "border-line hover:border-ink/40")}>
                      <span className={cx("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold", on ? "border-ink bg-ink text-white" : "border-line text-muted")}>{LETTER(k)}</span>
                      {o}
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-line pt-6">
              <Button variant="outline" disabled={i === 0} onClick={() => setI(i - 1)}>Previous</Button>
              <Button variant="ghost" onClick={toggleMark} aria-pressed={marked.includes(q.id)}>{marked.includes(q.id) ? "Marked for review" : "Mark for review"}</Button>
              <div className="ml-auto">
                {i < qs.length - 1 ? <Button onClick={() => setI(i + 1)}>Next</Button> : <Button onClick={() => setConfirm(true)}>Review and submit</Button>}
              </div>
            </div>
            {error && <p role="alert" className="mt-4 text-sm font-semibold">{error}</p>}
            <p className="mt-6 text-xs text-muted">Keys: A to F choose · ← → move · M mark</p>
          </div>
        </main>

        <aside className="w-72 shrink-0 overflow-y-auto border-l border-line p-6">
          {board ? <Whiteboard /> : (
            <>
              <div className="flex items-baseline justify-between">
                <p className="text-sm font-semibold">Questions</p>
                <p className="text-xs tabular-nums text-muted">{answered}/{qs.length}</p>
              </div>
              <ol className="mt-3 grid grid-cols-5 gap-2">
                {qs.map((x, k) => {
                  const a = (answers[x.id] || []).length > 0;
                  return (
                    <li key={x.id}>
                      <button type="button" onClick={() => setI(k)} aria-current={k === i ? "step" : undefined}
                        className={cx("relative flex h-10 w-full items-center justify-center rounded-lg border text-sm tabular-nums", a ? "border-ink bg-ink font-semibold text-white" : "border-line", k === i && "ring-2 ring-brand ring-offset-2")}>
                        {k + 1}
                        {marked.includes(x.id) && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-brand" />}
                      </button>
                    </li>
                  );
                })}
              </ol>
              <ul className="mt-4 space-y-1.5 text-xs text-muted">
                <li className="flex items-center gap-2"><span className="h-3 w-3 rounded border border-ink bg-ink" />Answered</li>
                <li className="flex items-center gap-2"><span className="h-3 w-3 rounded border border-line" />Not answered</li>
                <li className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-brand" />Marked for review</li>
              </ul>
            </>
          )}
        </aside>
      </div>

      {confirm && (
        <div role="dialog" aria-modal="true" aria-labelledby="sub-t" className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-6">
          <div className="w-full max-w-md rounded-2xl bg-white p-6">
            <h2 id="sub-t" className="font-display text-xl font-bold">Submit your exam?</h2>
            <p className="mt-2 text-[15px] text-muted">
              You answered {answered} of {qs.length}.{qs.length - answered ? ` ${qs.length - answered} unanswered count as wrong.` : ""}{marked.length ? ` ${marked.length} marked for review.` : ""}
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <Button variant="outline" onClick={() => setConfirm(false)}>Keep going</Button>
              <Button onClick={() => { setConfirm(false); finish(); }}>Submit</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Built-in whiteboard (like OnVUE): typed notes plus a drawing pad. Cleared after the exam. */
function Whiteboard() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [notes, setNotes] = useState("");
  const pos = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * canvas.current!.width, ((e.clientY - r.top) / r.height) * canvas.current!.height];
  };
  return (
    <div>
      <p className="text-sm font-semibold">Whiteboard</p>
      <label className="sr-only" htmlFor="notes">Notes</label>
      <textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={6} placeholder="Type notes here"
        className="mt-3 w-full resize-none rounded-xl border border-line p-3 text-sm outline-none focus:border-brand" />
      <canvas ref={canvas} width={480} height={520} aria-label="Drawing pad"
        className="mt-3 h-64 w-full touch-none rounded-xl border border-line bg-white"
        onPointerDown={(e) => { drawing.current = true; const c = canvas.current!.getContext("2d")!; const [x, y] = pos(e); c.beginPath(); c.moveTo(x, y); }}
        onPointerMove={(e) => { if (!drawing.current) return; const c = canvas.current!.getContext("2d")!; c.lineWidth = 2.5; c.lineCap = "round"; c.strokeStyle = "#171717"; const [x, y] = pos(e); c.lineTo(x, y); c.stroke(); }}
        onPointerUp={() => { drawing.current = false; }} onPointerLeave={() => { drawing.current = false; }} />
      <Button variant="ghost" className="mt-2 h-9 text-sm" onClick={() => { const c = canvas.current!; c.getContext("2d")!.clearRect(0, 0, c.width, c.height); }}>Clear drawing</Button>
    </div>
  );
}
