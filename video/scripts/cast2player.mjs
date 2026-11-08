// Turns a recorded asciicast (.cast) plus a speed plan into what termplayer/player.html loads:
//   termplayer/cast.js       window.CAST = [header, ...events]
//   termplayer/segments.js   window.SEGMENTS = [[fromCastSec, toCastSec, speed], ...]; window.CAST_MARKS = {beat: castSec}
// and writes data/term_segments.json (the same plan, with the resulting clip times) so the film can put a
// "sped up Nx" label exactly where the footage is sped up.
//
//   node scripts/cast2player.mjs <session.cast> <marks.json from record_pty> <plan.json>
// plan.json: {"segments": [[from, to, speed], ...]}  (cast seconds; gaps play at 1x)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const [castPath, marksPath, planPath] = process.argv.slice(2);
if (!castPath || !marksPath || !planPath) {
  console.error("usage: node scripts/cast2player.mjs <session.cast> <marks.json> <plan.json>");
  process.exit(2);
}
const lines = readFileSync(castPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const header = lines[0];
const events = lines.slice(1);
const castEnd = events.length ? events[events.length - 1][0] : 0;
const rec = JSON.parse(readFileSync(marksPath, "utf8"));
const castMarks = rec.marks || rec; // record_pty writes {t0, marks, epoch}
const plan = JSON.parse(readFileSync(planPath, "utf8"));

// Normalise the plan: sorted, non-overlapping, 1x in the gaps, covering [0, castEnd + 2].
const given = [...(plan.segments || [])].sort((a, b) => a[0] - b[0]);
const segs = [];
let cursor = 0;
for (const [from, to, speed] of given) {
  const f = Math.max(cursor, from);
  if (f > cursor) segs.push([cursor, f, 1]);
  if (to > f) segs.push([f, to, speed]);
  cursor = Math.max(cursor, to);
}
const tail = castEnd + 2;
if (cursor < tail) segs.push([cursor, tail, 1]);
segs[segs.length - 1][1] = 1e9;

// Clip time (seconds of footage) for a cast time, given the plan.
const clipTime = (t) => {
  let out = 0;
  for (const [from, to, speed] of segs) {
    if (t <= from) break;
    out += (Math.min(t, to) - from) / speed;
  }
  return out;
};

writeFileSync(join(ROOT, "termplayer/cast.js"), "window.CAST = " + JSON.stringify([header, ...events]) + ";\n");
writeFileSync(join(ROOT, "termplayer/segments.js"), `window.SEGMENTS = ${JSON.stringify(segs)};\nwindow.CAST_MARKS = ${JSON.stringify(castMarks)};\n`);
mkdirSync(join(ROOT, "data"), { recursive: true });
const report = {
  cast: castPath,
  cast_seconds: castEnd,
  clip_seconds: clipTime(castEnd),
  segments: segs.filter((s) => s[1] < 1e9 || s[0] < castEnd).map(([from, to, speed]) => ({
    cast_from: from, cast_to: Math.min(to, castEnd), speed, clip_from: clipTime(from), clip_to: clipTime(Math.min(to, castEnd)),
  })),
  marks: Object.fromEntries(Object.entries(castMarks).map(([k, v]) => [k, { cast: v, clip: clipTime(v) }])),
};
writeFileSync(join(ROOT, "data/term_segments.json"), JSON.stringify(report, null, 1));
console.log(`cast ${castEnd.toFixed(1)}s -> clip ${clipTime(castEnd).toFixed(1)}s; ${segs.length} segments; ${Object.keys(castMarks).length} marks`);
for (const s of report.segments) if (s.speed !== 1) console.log(`  ${s.cast_from}-${s.cast_to}s at ${s.speed}x -> clip ${s.clip_from.toFixed(1)}-${s.clip_to.toFixed(1)}s`);
