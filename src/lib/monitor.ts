/**
 * On-device AI proctoring. Runs MediaPipe Face Landmarker on the webcam
 * (about 2 frames a second) and a voice-level meter on the microphone, and
 * merges these with events from the main process (focus, full screen,
 * displays, blocked apps, shortcuts) into proctoring events with durations.
 *
 * A condition must hold for a short grace period before it counts, so a
 * blink or a cough is not a flag. Flags of severity 2+ attach one snapshot
 * (at most one every 20 s). Video never leaves the device otherwise.
 */
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { frame, logEvent, uploadImage } from "./api";
import type { MainEvent } from "./bridge";

export type Live = { faces: number; lookingAway: boolean; voice: boolean; level: number; flags: number };
type Cond = { kind: string; severity: number; graceMs: number };

const CONDS: Record<string, Cond> = {
  face_missing: { kind: "face_missing", severity: 3, graceMs: 3000 },
  multiple_faces: { kind: "multiple_faces", severity: 3, graceMs: 1500 },
  looking_away: { kind: "looking_away", severity: 2, graceMs: 4000 },
  voice: { kind: "voice", severity: 2, graceMs: 2500 },
  network_drop: { kind: "network_drop", severity: 1, graceMs: 5000 },
};

// Yaw/pitch thresholds (degrees) for "looking away" from the head pose matrix.
const YAW_LIMIT = 28;
const PITCH_LIMIT = 24;
const VOICE_RMS = 0.05;

let modelPromise: Promise<FaceLandmarker> | null = null;
/** Loads once; check-in warms it up so the exam starts instantly. */
export function faceModel(): Promise<FaceLandmarker> {
  modelPromise ||= loadFaceModel();
  return modelPromise;
}

async function loadFaceModel(): Promise<FaceLandmarker> {
  const files = await FilesetResolver.forVisionTasks(new URL("./mediapipe", location.href).href);
  return FaceLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: new URL("./models/face_landmarker.task", location.href).href, delegate: "GPU" },
    runningMode: "VIDEO",
    numFaces: 3,
    outputFacialTransformationMatrixes: true,
  });
}

/** Yaw and pitch in degrees from MediaPipe's 4x4 column-major transform. */
export function headPose(m: number[]): { yaw: number; pitch: number } {
  const r20 = m[2], r21 = m[6], r22 = m[10];
  const yaw = Math.atan2(-r20, Math.sqrt(r21 * r21 + r22 * r22)) * (180 / Math.PI);
  const pitch = Math.atan2(r21, r22) * (180 / Math.PI);
  return { yaw, pitch };
}

export class Monitor {
  private active = new Map<string, { since: number; counted: boolean; detail: Record<string, unknown> }>();
  private lastSnap = 0;
  private timer: number | null = null;
  private audio: { ctx: AudioContext; an: AnalyserNode; buf: Float32Array<ArrayBuffer> } | null = null;
  private flags = 0;
  private stopped = false;

  constructor(
    private sessionId: string,
    private video: HTMLVideoElement,
    private stream: MediaStream,
    private model: FaceLandmarker,
    private onLive: (l: Live) => void,
  ) {}

  start() {
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(this.stream);
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    this.audio = { ctx, an, buf: new Float32Array(new ArrayBuffer(an.fftSize * 4)) };
    this.stream.getVideoTracks()[0]?.addEventListener("ended", () => this.instant("webcam_lost", 3, {}));
    this.timer = window.setInterval(() => this.tick(), 500);
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const k of [...this.active.keys()]) await this.end(k);
    await this.audio?.ctx.close().catch(() => {});
  }

  /** Events from the main process (focus, full screen, displays, apps, keys). */
  fromMain(e: MainEvent) {
    if (e.kind === "focus_lost") {
      if (e.detail.phase === "start" || e.detail.phase === "minimize") this.begin("focus_lost", 2, {});
      else this.end("focus_lost");
      return;
    }
    this.instant(e.kind, e.severity, e.detail);
  }

  private tick() {
    if (this.stopped || this.video.readyState < 2) return;
    let faces = 0;
    let away = false;
    try {
      const r = this.model.detectForVideo(this.video, performance.now());
      faces = r.faceLandmarks.length;
      const m = r.facialTransformationMatrixes?.[0]?.data;
      if (faces === 1 && m) {
        const { yaw, pitch } = headPose(Array.from(m));
        away = Math.abs(yaw) > YAW_LIMIT || Math.abs(pitch) > PITCH_LIMIT;
      }
    } catch { /* a dropped frame is fine */ }

    let level = 0;
    if (this.audio) {
      this.audio.an.getFloatTimeDomainData(this.audio.buf);
      let sum = 0;
      for (const v of this.audio.buf) sum += v * v;
      level = Math.sqrt(sum / this.audio.buf.length);
    }
    const voice = level > VOICE_RMS;

    this.cond("face_missing", faces === 0, {});
    this.cond("multiple_faces", faces > 1, { faces });
    this.cond("looking_away", away, {});
    this.cond("voice", voice, {});
    this.cond("network_drop", !navigator.onLine, {});
    this.onLive({ faces, lookingAway: away, voice, level, flags: this.flags });
  }

  private cond(key: string, on: boolean, detail: Record<string, unknown>) {
    const c = CONDS[key];
    if (on) this.begin(key, c.severity, detail, c.graceMs);
    else this.end(key);
  }

  private begin(key: string, severity: number, detail: Record<string, unknown>, graceMs = 0) {
    const now = Date.now();
    const a = this.active.get(key);
    if (!a) { this.active.set(key, { since: now, counted: graceMs === 0, detail: { ...detail, severity } }); if (graceMs === 0) this.flagged(key, severity); return; }
    if (!a.counted && now - a.since >= graceMs) { a.counted = true; this.flagged(key, severity); }
  }

  private async end(key: string) {
    const a = this.active.get(key);
    if (!a) return;
    this.active.delete(key);
    if (!a.counted) return;
    const severity = Number(a.detail.severity ?? CONDS[key]?.severity ?? 1);
    const snapshot = severity >= 2 ? await this.snapshot(key) : null;
    await logEvent(this.sessionId, { kind: key, severity, duration_ms: Date.now() - a.since, detail: a.detail, snapshot_path: snapshot });
  }

  private flagged(_key: string, _severity: number) { this.flags += 1; }

  private async instant(kind: string, severity: number, detail: Record<string, unknown>) {
    this.flags += 1;
    const snapshot = severity >= 2 ? await this.snapshot(kind) : null;
    await logEvent(this.sessionId, { kind, severity, detail, snapshot_path: snapshot });
  }

  private async snapshot(kind: string): Promise<string | null> {
    const now = Date.now();
    if (now - this.lastSnap < 20000 || this.video.readyState < 2) return null;
    this.lastSnap = now;
    try { return await uploadImage(this.sessionId, `flag-${kind}-${now}.jpg`, await frame(this.video, 0.6, 480)); } catch { return null; }
  }
}
