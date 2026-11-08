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
const stop = await b.screencast(dir);
await sleep(800);
await b.js(`start(${Number(process.env.END || 1e9)})`);
while (!(await b.js("window.__done"))) await sleep(500);
await sleep(1500);
await stop();
const marks = existsSync(join(ROOT, ".cache/marks.json")) ? JSON.parse(readFileSync(join(ROOT, ".cache/marks.json"), "utf8")) : {};
for (const [k, v] of Object.entries(await b.js("window.__marks"))) marks[`${CLIP}.${k}`] = v;
writeFileSync(join(ROOT, ".cache/marks.json"), JSON.stringify(marks, null, 1));
console.log("captured", CLIP);
process.exit(0);
