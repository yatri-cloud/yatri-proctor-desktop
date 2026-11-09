import { SUPABASE_KEY, SUPABASE_URL } from "../config";

/*
 * Connection test, same method as speed.cloudflare.com:
 * - latency + jitter: 10 small requests to the exam server (Supabase) over a
 *   warm connection, median and mean consecutive difference.
 * - download / upload: growing payloads (100 kB up to 25 MB / 10 MB) from
 *   Cloudflare's speed endpoints. Download samples are request time minus one
 *   round trip (Resource Timing transfer time read several times too high
 *   against curl and macOS networkQuality). Upload samples use Resource
 *   Timing request-to-first-byte (the endpoint sends Timing-Allow-Origin: *)
 *   minus one round trip; this matched networkQuality within 1%. Sizes stop growing once one request
 *   takes over a second. Result = median of samples of 1 MB or more (not the
 *   90th percentile speed.cloudflare.com shows), because it decides pass/fail
 *   against the OnVUE minimums.
 */

export type NetResult = { latencyMs: number; jitterMs: number; downMbps: number; upMbps: number };
export type NetProgress = { phase: "latency" | "download" | "upload"; downMbps?: number; upMbps?: number; latencyMs?: number };

const CF = "https://speed.cloudflare.com";
const DOWN: [number, number][] = [[100_000, 1], [1_000_000, 3], [10_000_000, 2], [25_000_000, 1]];
const UP: [number, number][] = [[100_000, 1], [1_000_000, 3], [5_000_000, 2], [10_000_000, 1]];
const BUDGET_MS = 12_000; // per direction
const MIN_SAMPLE = 1_000_000;

export function percentile(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

const uid = () => Math.random().toString(36).slice(2);

/** One retry: a single dropped request on Wi-Fi should not fail the whole test. */
async function retry<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch { await new Promise((r) => setTimeout(r, 500)); return fn(); }
}
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Resource Timing entry for a URL; it can land a tick after the body resolves. */
async function entry(url: string) {
  for (let k = 0; k < 5; k++) {
    const e = performance.getEntriesByName(url, "resource").at(-1) as PerformanceResourceTiming | undefined;
    if (e && e.responseEnd > 0 && e.requestStart > 0 && e.responseStart > 0) return e;
    await new Promise((r) => setTimeout(r, 10));
  }
  return undefined;
}

async function latency() {
  const url = `${SUPABASE_URL}/auth/v1/health`;
  const ping = () => retry(async () => {
    const t = performance.now();
    await fetch(url, { cache: "no-store", headers: { apikey: SUPABASE_KEY } });
    return performance.now() - t;
  });
  await ping(); // warm up: DNS, TCP and TLS are not latency
  const xs: number[] = [];
  for (let k = 0; k < 10; k++) xs.push(await ping());
  let jitter = 0;
  for (let k = 1; k < xs.length; k++) jitter += Math.abs(xs[k] - xs[k - 1]);
  return { latencyMs: Math.round(percentile(xs, 0.5)), jitterMs: Math.round(jitter / (xs.length - 1)) };
}

/** Request-to-first-byte time for an empty response: subtracted from upload timings. */
async function cfBaseline() {
  const xs: number[] = [];
  for (let k = 0; k < 6; k++) {
    const url = `${CF}/__down?bytes=0&r=${uid()}`;
    const t = performance.now();
    await retry(async () => (await fetch(url, { cache: "no-store" })).arrayBuffer());
    const wall = performance.now() - t;
    const e = await entry(url);
    if (k > 0) xs.push(e ? e.responseStart - e.requestStart : wall); // first one opens the connection
  }
  return percentile(xs, 0.5);
}

async function downSample(bytes: number, base: number) {
  const url = `${CF}/__down?bytes=${bytes}&r=${uid()}`;
  const t = performance.now();
  const got = (await (await fetch(url, { cache: "no-store" })).arrayBuffer()).byteLength;
  const wall = performance.now() - t;
  const ms = Math.max(1, wall - base); // full request minus one round trip, as curl measures it
  return { bytes: got, ms, wall };
}

async function upSample(bytes: number, base: number, body: Uint8Array<ArrayBuffer>) {
  const url = `${CF}/__up?r=${uid()}`;
  const t = performance.now();
  await (await fetch(url, { method: "POST", body: body.subarray(0, bytes), cache: "no-store" })).arrayBuffer();
  const wall = performance.now() - t;
  const e = await entry(url);
  const sent = e ? e.responseStart - e.requestStart : wall;
  return { bytes, ms: Math.max(1, sent - base), wall };
}

async function series(plan: [number, number][], sample: (bytes: number) => Promise<{ bytes: number; ms: number; wall: number }>, onMbps: (m: number) => void) {
  const start = performance.now();
  const all: { bytes: number; mbps: number }[] = [];
  const result = () => {
    const big = all.filter((s) => s.bytes >= MIN_SAMPLE);
    return percentile((big.length ? big : all).map((s) => s.mbps), 0.5);
  };
  for (const [bytes, count] of plan) {
    let slow = false;
    for (let k = 0; k < count; k++) {
      let s;
      try { s = await retry(() => sample(bytes)); } catch (e) {
        // Cloudflare rate-limits repeated large requests (429 without CORS).
        // Keep what was measured; fail only if nothing was.
        if (all.some((x) => x.bytes >= MIN_SAMPLE)) return result();
        throw e;
      }
      all.push({ bytes: s.bytes, mbps: (s.bytes * 8) / (s.ms / 1000) / 1e6 });
      onMbps(round1(result()));
      if (s.wall > 1000) slow = true;
      if (performance.now() - start > BUDGET_MS) return result();
    }
    if (slow) break; // big enough to fill the line
  }
  return result();
}

export async function measureConnection(onProgress: (p: NetProgress) => void): Promise<NetResult> {
  performance.setResourceTimingBufferSize(1000);
  performance.clearResourceTimings();
  onProgress({ phase: "latency" });
  const { latencyMs, jitterMs } = await latency();
  onProgress({ phase: "download", latencyMs });
  const base = await cfBaseline();
  const downMbps = await series(DOWN, (b) => downSample(b, base), (m) => onProgress({ phase: "download", latencyMs, downMbps: m }));
  onProgress({ phase: "upload", latencyMs, downMbps: round1(downMbps) });
  const body = new Uint8Array(new ArrayBuffer(UP[UP.length - 1][0]));
  crypto.getRandomValues(body.subarray(0, 65536)); // not all zeros
  const upMbps = await series(UP, (b) => upSample(b, base, body), (m) => onProgress({ phase: "upload", latencyMs, downMbps: round1(downMbps), upMbps: m }));
  performance.clearResourceTimings();
  return { latencyMs, jitterMs, downMbps: round1(downMbps), upMbps: round1(upMbps) };
}
