// Records the real Faultline session (asciicast captured live from `hermes chat` by scripts/record_pty.py,
// turned into termplayer/cast.js + segments.js by scripts/cast2player.mjs) replayed in xterm.js:
// 1600x900 at device scale 2 -> .cache/frames/term/ (frames.json: epoch seconds), marks -> .cache/marks.json
// as term.<beat> in epoch seconds (the player stamps Date.now() when the replay passes each cast mark).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launch, sleep } from "./cdp.mjs";
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const PLAYER = process.env.PLAYER || join(ROOT, "termplayer/player.html");
const CLIP = process.env.CLIP || "term";
const dir = join(ROOT, ".cache/frames", CLIP);
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
const b = await launch({ width: 1600, height: 900, extraArgs: ["--force-device-scale-factor=2", "--allow-file-access-from-files"] });
await b.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 2, mobile: false });
await b.goto("file://" + PLAYER, 2500);
while (!(await b.js("window.__ready"))) await sleep(200);
console.log("font:", await b.js("window.__font"));
// The screencast only emits a frame when the compositor produces one, so a terminal that sits still
// between writes yields a handful of frames per second and can drop the last frame of a burst. A 1 px
// background-coloured dot with an endless transform animation keeps the compositor ticking, so the
// frames come at a steady rate with the real wall-clock timestamps; the dot itself is invisible.
await b.js(`(() => { const d = document.createElement("div"); d.id = "__tick";
  d.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;background:#141311;will-change:transform;animation:__tick 1s linear infinite;pointer-events:none";
  const s = document.createElement("style"); s.textContent = "@keyframes __tick { from { transform: translateX(0) } to { transform: translateX(0.5px) } }";
  document.head.appendChild(s); document.body.appendChild(d); return true; })()`);
const stop = await b.screencast(dir);
await sleep(800);
await b.js(`start(${Number(process.env.END || 1e9)})`);
const t0 = Date.now();
let lastLog = 0;
while (!(await b.js("window.__done"))) {
  await sleep(500);
  if (Date.now() - lastLog > 10000) { lastLog = Date.now(); console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)}s castT=${Number(await b.js("window.__castT")).toFixed(1)} marks=${Object.keys(await b.js("window.__marks")).length}`); }
}
await sleep(1500);
const frames = await stop();
const marks = existsSync(join(ROOT, ".cache/marks.json")) ? JSON.parse(readFileSync(join(ROOT, ".cache/marks.json"), "utf8")) : {};
const got = await b.js("window.__marks");
for (const [k, v] of Object.entries(got)) marks[`${CLIP}.${k}`] = v;
writeFileSync(join(ROOT, ".cache/marks.json"), JSON.stringify(marks, null, 1));
console.log(`captured ${CLIP}: ${frames.length} frames over ${(frames[frames.length - 1].t - frames[0].t).toFixed(1)}s, ${Object.keys(got).length} marks`);
if (b.consoleLines.length) console.log("console:", b.consoleLines.slice(0, 20));
b.close();
process.exit(0);
