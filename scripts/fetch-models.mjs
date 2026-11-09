// Copies the MediaPipe runtime (wasm) and downloads the face landmarker model
// into public/, so the app works offline and loads them over app://.
import { cp, mkdir, writeFile, stat } from "node:fs/promises";

const MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
await mkdir("public/models", { recursive: true });
await cp("node_modules/@mediapipe/tasks-vision/wasm", "public/mediapipe", { recursive: true });
const exists = await stat("public/models/face_landmarker.task").then(() => true, () => false);
if (!exists) {
  const res = await fetch(MODEL);
  if (!res.ok) throw new Error(`model download failed: ${res.status}`);
  await writeFile("public/models/face_landmarker.task", Buffer.from(await res.arrayBuffer()));
}
console.log("models ready");
