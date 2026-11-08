// Tiles out/stills/*.png into one contact sheet with ffmpeg xstack -> out/contact-sheet.png
//   node scripts/sheet.mjs            4 columns
//   COLS=3 node scripts/sheet.mjs
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const dir = join(ROOT, "out/stills");
const files = readdirSync(dir).filter((f) => f.endsWith(".png")).sort((a, b) => {
  const fa = +(a.match(/(\d+)\.png$/)?.[1] ?? 0), fb = +(b.match(/(\d+)\.png$/)?.[1] ?? 0);
  return fa - fb;
});
if (!files.length) { console.error("no stills in out/stills"); process.exit(1); }
const cols = +(process.env.COLS ?? 4);
const rows = Math.ceil(files.length / cols);
const [w, h] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", join(dir, files[0])]).toString().trim().split(",").map(Number);
const pad = 6, labelH = 28;
const cellW = w + pad, cellH = h + labelH + pad;
const n = cols * rows;
const args = ["-y", "-loglevel", "error"];
for (const f of files) args.push("-i", join(dir, f));
for (let i = files.length; i < n; i++) args.push("-f", "lavfi", "-i", `color=c=0x141311:s=${w}x${h}:d=1`);
// each input on a padded canvas (this ffmpeg has no drawtext; the order is the sorted file list, printed below)
const pre = Array.from({ length: n }, (_, i) => `[${i}:v]pad=${cellW}:${cellH}:0:${labelH}:color=0x0b0b0a[c${i}]`);
files.forEach((f, i) => console.log(`${String(i + 1).padStart(2)} row ${Math.floor(i / cols) + 1} col ${(i % cols) + 1}: ${f}`));
const layout = Array.from({ length: n }, (_, i) => `${(i % cols) * cellW}_${Math.floor(i / cols) * cellH}`).join("|");
const inputs = Array.from({ length: n }, (_, i) => `[c${i}]`).join("");
const filter = `${pre.join(";")};${inputs}xstack=inputs=${n}:layout=${layout}[out]`;
const out = join(ROOT, "out/contact-sheet.png");
args.push("-filter_complex", filter, "-map", "[out]", "-frames:v", "1", out);
execFileSync("ffmpeg", args, { stdio: "inherit" });
console.log(`${out}: ${files.length} stills, ${cols}x${rows}, ${cellW * cols}x${cellH * rows}`);
