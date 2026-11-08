// PROVISIONAL src/timing.json from script.json alone, so the film can be built before the voice exists.
//   node scripts/timing-provisional.mjs          writes src/timing.json unless a real one is there
//   FORCE=1 node scripts/timing-provisional.mjs  overwrite anyway
// Same shape scripts/timing.mjs produces (fps, totalFrames, bpm, beats, music, scenes[].lines[].words[]).
// Words are spread across each scene's planned seconds in proportion to their length, with a short
// lead and tail. It is marked "provisional": true so nobody mistakes it for measured timing.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "../..");
const OUT = join(ROOT, "src/timing.json");
const FPS = 30;
const LEAD = 14;
const TAIL = { close: 75, turn: 30, open: 24 };

if (existsSync(OUT) && !process.env.FORCE) {
  const cur = JSON.parse(readFileSync(OUT, "utf8"));
  if (!cur.provisional) { console.log("src/timing.json is real (not provisional); leaving it alone"); process.exit(0); }
}

const script = JSON.parse(readFileSync(join(ROOT, "script.json"), "utf8"));
let t = 0;
const scenes = [];
for (const sc of script.scenes) {
  const from = t;
  const durationInFrames = Math.round(sc.seconds * FPS);
  const tail = TAIL[sc.id] ?? 20;
  const window = durationInFrames - LEAD - tail;
  const lines = [];
  // one window shared by all lines of the scene, split by their word weight
  const allWords = sc.lines.map((l) => l.text.split(/\s+/).filter(Boolean));
  const weight = (w) => w.replace(/[^A-Za-z0-9']/g, "").length + 1.6 + (/[.,:;?!]$/.test(w) ? 2.2 : 0);
  const total = allWords.flat().reduce((n, w) => n + weight(w), 0);
  let cur = from + LEAD;
  sc.lines.forEach((line, i) => {
    const ws = allWords[i];
    const startFrame = Math.round(cur);
    const words = ws.map((w) => {
      const span = (weight(w) / total) * window;
      const start = Math.round(cur);
      const end = Math.max(start + 1, Math.round(cur + span * 0.82));
      cur += span;
      return { word: w, start, end };
    });
    const last = words[words.length - 1].end;
    lines.push({ voice: line.voice, text: line.text, file: `audio/vo/${sc.id}_${i}.mp3`, startFrame, durationFrames: last - startFrame + 6, words });
  });
  scenes.push({ id: sc.id, from, durationInFrames, lines });
  t = from + durationInFrames;
}
const bpm = 100;
const beats = [];
for (let b = 0; b * FPS < t; b += 60 / bpm) beats.push(Math.round(b * FPS));
const out = { fps: FPS, totalFrames: t, bpm, beats, music: { file: "audio/music.mp3", source: "provisional" }, provisional: true, scenes };
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`provisional timing: ${t}f = ${(t / FPS).toFixed(1)}s, scenes ${scenes.map((s) => `${s.id}@${s.from}+${s.durationInFrames}`).join(" ")}`);
