import { useState } from "react";
import { Button, Card, Shell } from "../ui";
import type { Session } from "../lib/api";
import { SUPPORT_EMAIL } from "../config";

/** Itemised consent before any camera, microphone or photo use (India DPDP Act). */
export default function Consent({ session, onAccept, onDecline }: { session: Session; onAccept: () => void; onDecline: () => void }) {
  const [ok, setOk] = useState(false);
  const items = [
    ["Webcam and microphone", "On during the exam. The app looks for faces, where you are looking and voices, on this computer."],
    ["Photos", "A photo of you, of your ID (optional for mock exams) and four photos of your room, before the exam."],
    ["Snapshots on flags", "If something looks wrong (no face, a second person, a voice), one still photo is saved with the flag."],
    ["Your computer", "Which apps are open, how many screens you have and whether it runs in a virtual machine. Blocked apps must be closed."],
    ["Who sees it", "You, and Yatri Cloud reviewers if your session is flagged. AI never fails you by itself; a person decides."],
    ["How long we keep it", "Photos and snapshots are deleted after 90 days. Ask us to delete them sooner any time."],
  ];
  return (
    <Shell step={0} title="Before we start" subtitle={`${session.cert_label}, proctored mock exam`}>
      <Card className="max-w-3xl">
        <h2 className="font-display text-xl font-bold">What Yatri Proctor collects, and why</h2>
        <dl className="mt-4 divide-y divide-line">
          {items.map(([k, v]) => (
            <div key={k} className="grid gap-1 py-3 sm:grid-cols-[200px_1fr]">
              <dt className="font-semibold">{k}</dt>
              <dd className="text-sm text-muted">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-sm text-muted">Purpose: to check this mock exam was taken by you, alone, without help. Questions or deletion requests: {SUPPORT_EMAIL}.</p>
        <label className="mt-6 flex items-start gap-3 text-[15px]">
          <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} className="mt-1 h-5 w-5 accent-[#007CFF]" />
          I agree to the above for this exam.
        </label>
        <div className="mt-6 flex gap-3">
          <Button disabled={!ok} onClick={onAccept}>Agree and continue</Button>
          <Button variant="ghost" onClick={onDecline}>I do not agree</Button>
        </div>
      </Card>
    </Shell>
  );
}
