import { useEffect, useState } from "react";
import { Button, Shell } from "../ui";
import { yp } from "../lib/bridge";
import { getSession, redeemLaunch, type Session } from "../lib/api";
import { SITE_URL } from "../config";

/** Waits for "Begin exam" on yatricloud.com (yatriproctor:// link) or a typed launch code. */
export default function Launch({ onReady }: { onReady: (s: Session) => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go(c: string) {
    const clean = c.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (clean.length !== 8) { setError("The launch code has 8 letters and numbers."); return; }
    setBusy(true);
    setError(null);
    try {
      const { sessionId } = await redeemLaunch(clean);
      onReady(await getSession(sessionId));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  useEffect(() => yp.onLaunch((c) => { setCode(c); go(c); }), []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Shell step={0} title="Welcome to Yatri Proctor" subtitle="Start your proctored mock exam from Yatri Pass. The app opens here and signs you in by itself.">
      <div className="grid max-w-4xl gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-line p-6">
          <p className="font-semibold">1. On yatricloud.com</p>
          <p className="mt-1 text-sm text-muted">Open your exam in Yatri Pass and press <span className="font-semibold text-ink">Take mock exam in Yatri Proctor</span>. Allow your browser to open this app.</p>
          <Button variant="outline" className="mt-5" onClick={() => window.open(`${SITE_URL}/pass`, "_blank")}>Open Yatri Pass</Button>
        </div>
        <div className="rounded-2xl border border-line p-6">
          <p className="font-semibold">2. Or type your launch code</p>
          <p className="mt-1 text-sm text-muted">The 8-character code is shown on the exam page. It works once, for 10 minutes.</p>
          <form className="mt-5 flex gap-3" onSubmit={(e) => { e.preventDefault(); go(code); }}>
            <label className="sr-only" htmlFor="code">Launch code</label>
            <input id="code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={9} placeholder="AB3D 9KQ2" autoFocus
              className="h-12 min-w-0 flex-1 rounded-xl border border-line px-4 font-mono text-lg tracking-[0.2em] outline-none focus:border-brand" />
            <Button type="submit" disabled={busy}>{busy ? "Signing in…" : "Continue"}</Button>
          </form>
          {error && <p role="alert" className="mt-3 text-sm font-medium text-ink">{error}</p>}
        </div>
      </div>
    </Shell>
  );
}
