// Renders check stills of the Faultline composition at half scale -> out/stills/<scene>-<frame>.png
//   node scripts/stills.mjs                 three frames per scene (15%, 50%, 85% of each scene)
//   node scripts/stills.mjs 140 420 960     explicit absolute frames (-> out/stills/f<frame>.png)
//   SCENES=open,fix node scripts/stills.mjs  only some scenes
//   AT=0.1,0.5,0.9 node scripts/stills.mjs   other fractions of each scene
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const timing = JSON.parse(readFileSync(join(ROOT, "src/timing.json"), "utf8"));
const only = process.env.SCENES?.split(",");
const fractions = (process.env.AT ?? "0.15,0.5,0.85").split(",").map(Number);
const explicit = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n));

const jobs = explicit.length
  ? explicit.map((frame) => ({ frame, name: `f${frame}` }))
  : timing.scenes
      .filter((s) => !only || only.includes(s.id))
      .flatMap((s) => fractions.map((p) => {
        const frame = Math.min(s.from + s.durationInFrames - 1, s.from + Math.round(s.durationInFrames * p));
        return { frame, name: `${s.id}-${String(frame).padStart(4, "0")}` };
      }));

const dir = join(ROOT, "out/stills");
if (!explicit.length && !only) rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const serveUrl = await bundle({ entryPoint: join(ROOT, "src/index.ts"), publicDir: join(ROOT, "public") });
const composition = await selectComposition({ serveUrl, id: "Faultline" });
for (const { frame, name } of jobs) {
  const output = join(dir, `${name}.png`);
  try {
    await renderStill({ composition, serveUrl, frame, output, scale: 0.5, imageFormat: "png" });
    console.log(output);
  } catch (e) { console.log(`${name}: FAILED ${String(e.message).split("\n")[0]}`); }
}
process.exit(0);
