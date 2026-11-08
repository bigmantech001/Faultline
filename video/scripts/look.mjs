// Dev helper: viewport screenshots of live routes at 1600x900 for planning the capture.
//   OUT=<dir> node scripts/look.mjs [route ...]
import { launch, sleep } from "./cdp.mjs";
import { join } from "node:path";
const BASE = process.env.BASE || "https://useanimr.vercel.app";
const OUT = process.env.OUT;
const routes = process.argv.slice(2);
const b = await launch({ width: 1600, height: 900 });
for (const r of routes) {
  await b.goto(BASE + r, 9000);
  const name = r.replace(/[^a-z0-9]+/gi, "_") || "root";
  await b.shot(join(OUT, `${name}.png`));
  const h = await b.js("document.documentElement.scrollHeight");
  const text = await b.js("document.body.innerText.slice(0, 1500)");
  console.log("=====", r, "height", h, "\n", text);
}
console.log(b.consoleLines.slice(0, 10));
b.close();
