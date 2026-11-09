import { useEffect, useRef, useState } from "react";
import { Button, Card, Shell, cx } from "../ui";
import type { SystemInfo } from "../lib/bridge";
import { frame, saveCheckin, uploadImage, type Session } from "../lib/api";
import { faceModel } from "../lib/monitor";

type Shot = { key: string; title: string; help: string; optional?: boolean; needsFace?: boolean };
const SHOTS: Shot[] = [
  { key: "headshot", title: "Your photo", help: "Look straight at the camera, face fully visible, no hat or sunglasses.", needsFace: true },
  { key: "id-front", title: "ID, front", help: "Hold a government ID (Aadhaar, PAN, passport, driving licence) close to the camera.", optional: true },
  { key: "id-back", title: "ID, back", help: "Turn the ID over.", optional: true },
  { key: "room-front", title: "Room: in front of you", help: "Turn your laptop or webcam to show your desk and the wall in front of you." },
  { key: "room-right", title: "Room: your right", help: "Turn to show the area on your right." },
  { key: "room-back", title: "Room: behind you", help: "Turn to show what is behind you." },
  { key: "room-left", title: "Room: your left", help: "Turn to show the area on your left, then turn back." },
];

/*
 * Check-in (like OnVUE): headshot (must show exactly one face), ID front and
 * back (optional for mock exams), four room photos. Each photo uploads to the
 * private proctor-media bucket; the list is saved on the session.
 */
export default function CheckIn({ session, device, stream, onDone }: { session: Session; device: SystemInfo | null; stream: MediaStream; onDone: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [i, setI] = useState(0);
  const [preview, setPreview] = useState<{ url: string; blob: Blob } | null>(null);
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [skipId, setSkipId] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (video.current) { video.current.srcObject = stream; video.current.play().catch(() => {}); }
    faceModel().catch(() => {}); // warm up for the exam
  }, [stream, preview]);

  const shots = SHOTS.filter((s) => !(skipId && s.optional));
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
        await saveCheckin(session.id, device, { photos: next, id_skipped: skipId, at: new Date().toISOString() });
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
            {shot.optional && !preview && <Button variant="ghost" onClick={() => setSkipId(true)}>Skip ID (mock exam)</Button>}
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
