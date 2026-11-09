import { createClient } from "@supabase/supabase-js";
import { SITE_URL, SUPABASE_KEY, SUPABASE_URL } from "../config";
import { yp } from "./bridge";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "yp-auth" },
});

export type Domain = { key: string; name: string; weight: number };
export type Question = { id: string; domain_key: string; stem: string; options: string[]; multi: boolean; correct: number[] | null; explanation: string | null };
export type Session = {
  id: string; mode: string; certification_id: string; cert_label: string; exam_code: string | null; badge_url: string | null;
  duration_sec: number | null; started_at: string; submitted_at: string | null;
  answers: Record<string, number[]>; marked: string[];
  correct: number | null; total: number | null; score: number | null; pass_mark: number | null; passed: boolean | null;
  breakdown: Record<string, { correct: number; total: number }> | null; questions: Question[]; domains: Domain[] | null;
  risk_score?: number;
};

export class ApiError extends Error {}
const fail = (m?: string) => { throw new ApiError(friendly(m)); };
function friendly(m = "") {
  if (m.includes("test_not_found")) return "This exam is not available any more.";
  if (m.includes("not_authenticated")) return "Your session ended. Start again from yatricloud.com.";
  return m || "Something went wrong. Check your connection and try again.";
}

/** Exchanges a one-time launch code from yatricloud.com for a signed-in session. */
export async function redeemLaunch(code: string): Promise<{ sessionId: string; email: string }> {
  // In the app the main process makes this call; in a browser (dev) we call directly.
  const r = yp.redeem
    ? await yp.redeem(code)
    : await fetch(`${SITE_URL}/api/pass/proctor.redeem`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) })
        .then(async (res) => ({ ok: res.ok, json: await res.json().catch(() => ({})) }));
  const json = r.json;
  if (!r.ok) fail(json.error);
  const { error } = await supabase.auth.verifyOtp({ type: "magiclink", token_hash: json.token_hash });
  if (error) fail(error.message);
  return { sessionId: json.session_id, email: json.email };
}

export async function getSession(id: string): Promise<Session> {
  const { data, error } = await supabase.rpc("pass_get_test", { p_session: id });
  if (error) fail(error.message);
  return data as Session;
}

export async function saveAnswers(id: string, answers: Record<string, number[]>, marked: string[]) {
  const { error } = await supabase.rpc("pass_save_test", { p_session: id, p_answers: answers, p_marked: marked });
  if (error) fail(error.message);
}

export async function submit(id: string, answers: Record<string, number[]>, marked: string[]): Promise<Session> {
  const { data, error } = await supabase.rpc("pass_submit_proctored", { p_session: id, p_answers: answers, p_marked: marked });
  if (error) fail(error.message);
  return data as Session;
}

export async function saveCheckin(id: string, device: unknown, checkin: unknown) {
  const { error } = await supabase.rpc("pass_proctor_checkin", { p_session: id, p_device: device, p_checkin: checkin });
  if (error) fail(error.message);
}

async function userId() {
  const { data } = await supabase.auth.getUser();
  if (!data.user) fail("not_authenticated");
  return data.user!.id;
}

/** Uploads a JPEG to proctor-media/<user>/<session>/<name> and returns the path. */
export async function uploadImage(sessionId: string, name: string, blob: Blob): Promise<string> {
  const path = `${await userId()}/${sessionId}/${name}`;
  const { error } = await supabase.storage.from("proctor-media").upload(path, blob, { contentType: "image/jpeg", upsert: true });
  if (error) fail(error.message);
  return path;
}

export async function logEvent(sessionId: string, ev: { kind: string; severity: number; duration_ms?: number; detail?: unknown; snapshot_path?: string | null }) {
  const { error } = await supabase.from("pass_proctor_events").insert({
    session_id: sessionId, user_id: await userId(), kind: ev.kind, severity: ev.severity,
    duration_ms: Math.round(ev.duration_ms || 0), detail: ev.detail || {}, snapshot_path: ev.snapshot_path || null,
  });
  if (error) console.warn("[proctor] event not saved", error.message);
}

/** Grabs a JPEG frame from a playing video element. */
export function frame(video: HTMLVideoElement, quality = 0.7, maxW = 640): Promise<Blob> {
  const scale = Math.min(1, maxW / (video.videoWidth || maxW));
  const c = document.createElement("canvas");
  c.width = Math.round((video.videoWidth || 640) * scale);
  c.height = Math.round((video.videoHeight || 480) * scale);
  c.getContext("2d")!.drawImage(video, 0, 0, c.width, c.height);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("no frame"))), "image/jpeg", quality));
}

/** Starts the exam clock (first call only) and returns the start time. */
export async function beginExam(id: string): Promise<string> {
  const { data, error } = await supabase.rpc("pass_proctor_begin", { p_session: id });
  if (error) fail(error.message);
  return data as string;
}
