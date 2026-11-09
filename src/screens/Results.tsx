import { Button, Card, Shell } from "../ui";
import { yp } from "../lib/bridge";
import type { Session } from "../lib/api";
import { SITE_URL } from "../config";

/** Score against the pass mark, domain breakdown and the review status. */
export default function Results({ session }: { session: Session }) {
  const score = Math.round(Number(session.score || 0));
  const flagged = Number(session.risk_score || 0) >= 15;
  return (
    <Shell step={3} title={session.passed ? "You passed this mock exam." : "Not yet at the pass mark."}
      subtitle={`${score}% · pass mark ${Math.round(Number(session.pass_mark || 70))}% · ${session.correct}/${session.total} correct`}>
      <div className="grid max-w-4xl gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="font-display text-lg font-bold">By domain</h2>
          <ul className="mt-4 space-y-4">
            {(session.domains || []).filter((d) => session.breakdown?.[d.key]).map((d) => {
              const b = session.breakdown![d.key];
              return (
                <li key={d.key}>
                  <div className="flex justify-between gap-3 text-sm"><span>{d.name}</span><span className="tabular-nums text-muted">{b.correct}/{b.total}</span></div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(2, (100 * b.correct) / Math.max(1, b.total))}%` }} /></div>
                </li>
              );
            })}
          </ul>
        </Card>
        <Card>
          <h2 className="font-display text-lg font-bold">Proctoring</h2>
          <p className="mt-2 text-[15px] text-muted">
            {flagged
              ? "Some moments were flagged (for example leaving the frame or a voice). A Yatri Cloud reviewer will look at them; AI alone never fails anyone."
              : "No concerns were found. Your session counts as a clean proctored attempt."}
          </p>
          <p className="mt-4 text-sm text-muted">Full answers and explanations are in your Yatri Pass dashboard.</p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button onClick={() => window.open(`${SITE_URL}/pass/test/${session.id}`, "_blank")}>Review answers</Button>
            <Button variant="outline" onClick={() => yp.quit()}>Close Yatri Proctor</Button>
          </div>
        </Card>
      </div>
    </Shell>
  );
}
