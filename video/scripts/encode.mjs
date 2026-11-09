// .cache/frames/<clip>/ (screencast JPEGs + frames.json) -> public/footage/<clip>.mp4 at a
// constant 30 fps (real wall-clock timing), and src/footage.json with each clip's file, size,
// length, event marks (frames from the clip's start, from .cache/marks.json), the speed plan the
// clip was replayed with (data/<clip>_segments.json, aligned to the clip by its own marks) and what
// scripts/capture.mjs noted about it (.cache/meta.json: element rects in CSS px, device scale).
//   node scripts/encode.mjs            all clips
//   ONLY=why,graph node scripts/encode.mjs
//   REUSE=1 node scripts/encode.mjs    keep an existing mp4, only rewrite src/footage.json (marks, segments)
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { concatList } from "./cdp.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const FR = join(ROOT, ".cache/frames");
const FPS = 30;
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {});
const marks = readJson(join(ROOT, ".cache/marks.json"));
const meta = readJson(join(ROOT, ".cache/meta.json"));
const out = readJson(join(ROOT, "src/footage.json"));
const only = process.env.ONLY?.split(",");
const reuse = Boolean(process.env.REUSE);
mkdirSync(join(ROOT, "public/footage"), { recursive: true });

for (const clip of readdirSync(FR)) {
  if (only && !only.includes(clip)) continue;
  const fj = join(FR, clip, "frames.json");
  if (!existsSync(fj)) continue;
  const frames = JSON.parse(readFileSync(fj, "utf8"));
  if (!frames.length) continue;
  const file = `footage/${clip}.mp4`;
  const abs = join(ROOT, "public", file);
  if (reuse && existsSync(abs)) {
    console.log(`${clip}: reusing ${file}`);
  } else {
    const list = join(FR, clip, "list.txt");
    writeFileSync(list, concatList(frames));
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list,
      "-vf", `fps=${FPS},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`, "-c:v", "libx264", "-crf", "15", "-preset", "medium", "-movflags", "+faststart", abs]);
  }
  const [w, h] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", abs]).toString().trim().split(",").map(Number);
  const dur = parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", abs]).toString());
  const t0 = frames[0].t;
  const tEnd = frames[frames.length - 1].t;
  // The mp4 plays frames in index order, each held for max(0.01, next.t - this.t) seconds (concatList),
  // then resampled to a constant FPS. So a frame's position in the clip is the CUMULATIVE held time
  // before it, not (epoch - t0): the screencast timestamps are not evenly spaced and can jitter
  // backwards, so (epoch - t0)*FPS lands on the wrong frame. Build the cumulative timeline and map
  // each mark (a Date.now() epoch) to the clip frame of the last screencast frame on screen at that epoch.
  const start = new Array(frames.length);
  start[0] = 0;
  for (let i = 1; i < frames.length; i++) start[i] = start[i - 1] + Math.max(0.01, frames[i].t - frames[i - 1].t);
  const clipFrameAt = (epoch) => {
    let idx = -1;
    for (let i = 0; i < frames.length; i++) if (frames[i].t <= epoch) idx = i;
    if (idx < 0) return -1;
    return Math.round(start[idx] * FPS);
  };
  const m = {};
  for (const [k, v] of Object.entries(marks)) {
    if (k.includes(":")) continue; // clip start/end bookkeeping
    if (!k.startsWith(`${clip}.`)) continue; // a clip carries its own beats only
    if (v > tEnd + 0.5) continue;
    const f = clipFrameAt(v);
    if (f >= 0) m[k] = f;
  }
  // concatList rounds each frame's duration to 3 decimals, and the concat demuxer + fps filter
  // quantise further, so the clipFrameAt estimate drifts a few percent across a long clip. For the
  // beats the scenes actually seek to, data/<clip>_mark_frames.json holds the frame numbers verified
  // by extracting the real mp4 (ffmpeg -vf select); those override the estimate.
  const pinned = readJson(join(ROOT, "data", `${clip}_mark_frames.json`));
  for (const [beat, f] of Object.entries(pinned)) {
    if (typeof f === "number" && Number.isFinite(f)) m[beat.startsWith(`${clip}.`) ? beat : `${clip}.${beat}`] = f;
  }
  // The replay plan (clip seconds from the player's start) -> clip frames, aligned by the beats the
  // player stamped, so the "waits sped up Nx" label sits exactly where the footage is sped up.
  let segments;
  const plan = readJson(join(ROOT, "data", `${clip}_segments.json`));
  if (plan.segments?.length && plan.marks) {
    const offs = Object.entries(plan.marks)
      .filter(([k, v]) => typeof v?.clip === "number" && typeof m[`${clip}.${k}`] === "number")
      .map(([k, v]) => m[`${clip}.${k}`] - Math.round(v.clip * FPS))
      .sort((a, b) => a - b);
    if (offs.length) {
      const offset = offs[Math.floor(offs.length / 2)];
      segments = plan.segments.map((s) => ({ from: Math.round(s.clip_from * FPS) + offset, to: Math.round(s.clip_to * FPS) + offset, speed: s.speed }));
      console.log(`${clip}: plan offset ${offset} frames (spread ${offs[0]}..${offs[offs.length - 1]} over ${offs.length} marks)`);
    }
  }
  out[clip] = { file, width: w, height: h, durationFrames: Math.floor(dur * FPS), marks: m, ...(segments ? { segments } : {}), ...(meta[clip] ?? {}) };
  console.log(`${clip}: ${w}x${h} ${dur.toFixed(1)}s marks ${JSON.stringify(m)}`);
}
writeFileSync(join(ROOT, "src/footage.json"), JSON.stringify(out, null, 1));
