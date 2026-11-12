import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Button, Card, Shell, cx } from "../ui";
import type { SystemInfo } from "../lib/bridge";
import { createMobileCheckin, downloadImage, frame, mobileRetake, mobileStatus, saveCheckin, uploadImage, type Session } from "../lib/api";
import { faceModel } from "../lib/monitor";
import { SITE_URL } from "../config";

type Shot = { key: string; title: string; help: string; needsFace?: boolean };
const SHOTS: Shot[] = [
  { key: "headshot", title: "Your photo", help: "Look straight at the camera, face fully visible, no hat or sunglasses.", needsFace: true },
  { key: "room-front", title: "Room: in front of you", help: "Turn your laptop or webcam to show your desk and the wall in front of you." },
  { key: "room-right", title: "Room: your right", help: "Turn to show the area on your right." },
  { key: "room-back", title: "Room: behind you", help: "Turn to show what is behind you." },
  { key: "room-left", title: "Room: your left", help: "Turn to show the area on your left, then turn back." },
];

type Props = { session: Session; device: SystemInfo | null; stream: MediaStream; onDone: () => void };

/*
 * Check-in (like OnVUE): headshot (must show exactly one face) and four room
 * photos. No ID documents since 1.0.7 (DPDP data minimisation; storage also
 * refuses checkin-id-* uploads). By default the photos are
 * taken on the learner's phone (QR code -> yatricloud.com/pass/checkin); the
 * computer's camera is the fallback. Either way they land in the private
 * proctor-media bucket and the list is saved on the session.
 */
export default function CheckIn(p: Props) {
  const [mode, setMode] = useState<"phone" | "computer">("phone");
  return mode === "phone" ? <PhoneCheckIn {...p} onUseComputer={() => setMode("computer")} /> : <ComputerCheckIn {...p} onUsePhone={() => setMode("phone")} />;
}

const ROOM = ["room-front", "room-right", "room-back", "room-left"];

function PhoneCheckIn({ session, device, onDone, onUseComputer }: Props & { onUseComputer: () => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const [state, setState] = useState<Awaited<ReturnType<typeof mobileStatus>>>(null);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const newCode = useCallback(async () => {
    setError(null); setQr(null);
    try {
      const token = await createMobileCheckin(session.id);
      setQr(await QRCode.toDataURL(`${SITE_URL}/pass/checkin#t=${token}`, { margin: 1, width: 560, errorCorrectionLevel: "M", color: { dark: "#0f172a", light: "#ffffff" } }));
    } catch (e) { setError((e as Error).message); }
  }, [session.id]);
  useEffect(() => { newCode(); }, [newCode]);

  async function refresh() {
    setChecking(true); setMessage(null); setError(null);
    try {
      const st = await mobileStatus(session.id);
      setState(st);
      const photos = st?.photos || {};
      const need = 5;
      const got = Object.keys(photos).length;
      if (!st?.completed_at) { setMessage(got ? `${got} of ${need} photos received. Finish on your phone, then click Refresh.` : "No photos yet. Scan the QR code with your phone and take the photos."); return; }
      // The headshot must show exactly one face, same rule as the computer camera.
      if (!device?.e2e) {
        try {
          const bmp = await createImageBitmap(await downloadImage(photos.headshot));
          const faces = (await faceModel()).detectForVideo(bmp, performance.now()).faceLandmarks.length;
          bmp.close();
          if (faces !== 1) {
            await mobileRetake(session.id, "headshot");
            setState(await mobileStatus(session.id));
            setMessage(faces === 0 ? "We cannot see a face in your photo. On your phone, take Your photo again with your face in good light, then click Refresh." : "More than one face is in your photo. Only you should be in it. Take it again on your phone, then click Refresh.");
            return;
          }
        } catch { /* model unavailable: the reviewer checks the photo */ }
      }
      await saveCheckin(session.id, device, { photos, id_skipped: true, via: "phone", at: new Date().toISOString() });
      onDone();
    } catch (e) { setError((e as Error).message); } finally { setChecking(false); }
  }

  const photos = state?.photos || {};
  const list = [["headshot", "Your photo"], ...ROOM.map((k) => [k, `Room: ${k.replace("room-", "").replace("back", "behind you").replace("front", "in front of you").replace(/^(right|left)$/, "your $1")}`])];
  return (
    <Shell step={1} title="Check-in" subtitle="Take your check-in photos with your phone">
      <Card className="max-w-4xl p-8">
        <div className="flex items-center gap-8">
          <div className="flex h-52 w-52 shrink-0 items-center justify-center rounded-2xl border border-line bg-white p-2.5">
            {qr ? <img src={qr} alt="QR code that opens check-in on your phone" className="h-full w-full" /> : <span className="text-sm text-muted">{error ? "No code" : "Making code…"}</span>}
          </div>
          <ol className="min-w-0 flex-1 space-y-4 text-[15px]">
            {[["Scan the code", "Open the camera on your phone and point it at the code. Tap the link that appears."],
              ["Take the photos", "Your photo and four photos of your room. No ID document is needed."],
              ["Come back here", "When your phone says All photos sent, click Refresh."]].map(([t, d], k) => (
              <li key={t} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">{k + 1}</span>
                <div><p className="font-semibold leading-6">{t}</p><p className="mt-0.5 text-sm leading-5 text-muted">{d}</p></div>
              </li>
            ))}
          </ol>
        </div>

        <ul aria-label="Photos received" className="mt-6 grid grid-cols-2 gap-x-6 gap-y-2 rounded-xl border border-line p-4 text-sm sm:grid-cols-4">
          {list.map(([k, t]) => (
            <li key={k} className="flex items-center gap-2">
              <span className={cx("flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold", photos[k] ? "border-brand bg-brand text-white" : "border-line")}>{photos[k] ? "✓" : ""}</span>
              <span className={photos[k] ? "font-semibold text-ink" : "text-muted"}>{t}</span>
            </li>
          ))}
        </ul>

        {message && <p role="status" className="mt-4 rounded-xl bg-canvas px-4 py-3 text-sm font-semibold">{message}</p>}
        {error && <p role="alert" className="mt-4 text-sm font-semibold">{error}</p>}
        <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-6">
          <Button onClick={refresh} disabled={checking || !qr}>{checking ? "Checking…" : "Refresh"}</Button>
          <Button variant="outline" onClick={newCode}>Show a new QR code</Button>
          <Button variant="ghost" onClick={onUseComputer}>No phone? Use this computer's camera</Button>
        </div>
        <details className="mt-6 rounded-xl border border-line bg-canvas px-4 py-3 text-sm">
          <summary className="cursor-pointer select-none font-semibold">Having trouble? Fix it here</summary>
          <ol className="mt-3 list-decimal space-y-2 pl-5 leading-relaxed text-ink/80">
            <li>Nothing happens when you scan: use the phone's built-in Camera app (iPhone) or Google Lens (Android), held 20 to 30 cm from the screen.</li>
            <li>The phone says the link expired: links last 30 minutes. Click Show a new QR code and scan again. Photos already sent are kept.</li>
            <li>Photos will not send: switch the phone from Wi-Fi to mobile data, or the other way round.</li>
            <li>Refresh says photos are missing: finish every photo on the phone and tap Finish check-in.</li>
            <li>After check-in, put the phone face down out of reach. Phones are not allowed during the exam.</li>
          </ol>
        </details>
      </Card>
    </Shell>
  );
}

function ComputerCheckIn({ session, device, stream, onDone, onUsePhone }: Props & { onUsePhone: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [i, setI] = useState(0);
  const [preview, setPreview] = useState<{ url: string; blob: Blob } | null>(null);
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (video.current) { video.current.srcObject = stream; video.current.play().catch(() => {}); }
    faceModel().catch(() => {}); // warm up for the exam
  }, [stream, preview]);

  const shots = SHOTS;
  const shot = shots[i];

  async function capture() {
    if (!video.current) return;
    setError(null);
    if (shot.needsFace && !device?.e2e) {
      try {
        const model = await faceModel();
        const faces = model.detectForVideo(video.current, performance.now()).faceLandmarks.length;
        if (faces !== 1) { setError(faces === 0 ? "We cannot see your face. Move closer and face the light." : "More than one face is visible. Only you should be in view."); return; }
      } catch { /* model unavailable: allow, reviewer checks the photo */ }
    }
    const blob = await frame(video.current, 0.85, 1280);
    setPreview({ url: URL.createObjectURL(blob), blob });
  }

  async function accept() {
    if (!preview) return;
    setBusy(true);
    try {
      const path = await uploadImage(session.id, `checkin-${shot.key}.jpg`, preview.blob);
      const next = { ...paths, [shot.key]: path };
      setPaths(next);
      URL.revokeObjectURL(preview.url);
      setPreview(null);
      if (i + 1 < shots.length) setI(i + 1);
      else {
        await saveCheckin(session.id, device, { photos: next, id_skipped: true, at: new Date().toISOString() });
        onDone();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell step={1} title="Check-in" subtitle={`Step ${i + 1} of ${shots.length}: ${shot.title}`}>
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card className="p-4">
          <div className="relative overflow-hidden rounded-xl bg-ink">
            {preview
              ? <img src={preview.url} alt={`Your ${shot.title} photo`} className="aspect-video w-full object-cover" />
              : <video ref={video} muted playsInline className={cx("aspect-video w-full object-cover", !shot.key.startsWith("room") && "-scale-x-100")} />}
            {shot.key === "headshot" && !preview && <div aria-hidden="true" className="pointer-events-none absolute left-1/2 top-1/2 h-[62%] w-[34%] -translate-x-1/2 -translate-y-1/2 rounded-[50%] border-2 border-dashed border-white/80" />}
          </div>
          <p className="mt-4 text-[15px] text-ink">{shot.help}</p>
          {error && <p role="alert" className="mt-2 text-sm font-semibold text-ink">{error}</p>}
          <div className="mt-4 flex flex-wrap gap-3">
            {!preview ? <Button onClick={capture}>Take photo</Button> : (
              <>
                <Button onClick={accept} disabled={busy}>{busy ? "Uploading…" : "Use this photo"}</Button>
                <Button variant="outline" onClick={() => { URL.revokeObjectURL(preview.url); setPreview(null); }}>Retake</Button>
              </>
            )}
            {!preview && <Button variant="ghost" onClick={onUsePhone}>Use my phone instead</Button>}
          </div>
        </Card>
        <Card>
          <p className="text-sm font-semibold">Photos</p>
          <ol className="mt-3 space-y-2 text-sm">
            {shots.map((s, k) => (
              <li key={s.key} className="flex items-center gap-2.5">
                <span className={cx("flex h-5 w-5 items-center justify-center rounded-full border text-[10px] font-bold", paths[s.key] ? "border-brand bg-brand text-white" : k === i ? "border-ink" : "border-line")}>{paths[s.key] ? "✓" : k + 1}</span>
                <span className={k === i ? "font-semibold text-ink" : "text-muted"}>{s.title}</span>
              </li>
            ))}
          </ol>
          <p className="mt-6 text-xs leading-relaxed text-muted">Keep your desk clear: no phone within reach, no notes, books or second screen. Headphones are not allowed.</p>
        </Card>
      </div>
    </Shell>
  );
}
