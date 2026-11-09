import { Button, Card, Shell } from "../ui";
import type { Session } from "../lib/api";

/** Exam rules (OnVUE style) and the start button that enters lockdown. */
export default function Ready({ session, onStart }: { session: Session; onStart: () => void }) {
  const mins = Math.round((session.duration_sec || 0) / 60);
  const rules = [
    "Stay in view of the camera for the whole exam. Do not leave your seat.",
    "No one else may be in the room. Keep the room quiet and do not read questions aloud.",
    "No phone, notes, books, smart watch or headphones. Use the built-in whiteboard for working.",
    "Yatri Proctor goes full screen. Switching apps, leaving full screen or adding a screen is recorded.",
    "AI watches for these moments and saves a snapshot. A person reviews flagged sessions; AI alone never fails you.",
  ];
  return (
    <Shell step={1} title="You are ready" subtitle={`${session.cert_label} · ${session.questions.length} questions · ${mins} minutes`}>
      <Card className="max-w-3xl">
        <h2 className="font-display text-xl font-bold">Exam rules</h2>
        <ol className="mt-4 space-y-3">
          {rules.map((r, i) => (
            <li key={r} className="flex gap-3 text-[15px]">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">{i + 1}</span>
              {r}
            </li>
          ))}
        </ol>
        <p className="mt-6 text-sm text-muted">The timer starts when you press Start. Your answers save as you go; if the app closes, open it again and continue.</p>
        <Button className="mt-6" onClick={onStart}>Start exam</Button>
      </Card>
    </Shell>
  );
}
