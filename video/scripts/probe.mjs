// Dev helper: open a live route (guide marked seen), print buttons and text, full-page screenshot.
//   OUT=<dir> node scripts/probe.mjs /route [fullpage=1]
import { launch, sleep } from "./cdp.mjs";
import { join } from "node:path";
const BASE = process.env.BASE || "https://useanimr.vercel.app";
const r = process.argv[2];
const b = await launch({ width: 1600, height: 900 });
await b.goto(BASE + "/docs", 2500);
await b.js(`localStorage.setItem('animr:coach','done')`);
await b.goto(BASE + r, 9000);
const btns = await b.js(`[...document.querySelectorAll('button,a')].map(e=>e.tagName[0]+':'+e.textContent.trim().replace(/\\s+/g,' ').slice(0,60)+(e.getAttribute('aria-label')?' ['+e.getAttribute('aria-label')+']':'')).filter(x=>x.length>2).join('\\n')`);
console.log(btns);
console.log("-----\n" + (await b.js("document.body.innerText")).slice(0, +process.env.N || 4000));
const h = await b.js("document.documentElement.scrollHeight");
await b.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: Math.min(h, 7000), deviceScaleFactor: 1, mobile: false });
await sleep(1500);
await b.shot(join(process.env.OUT, (r.replace(/[^a-z0-9]+/gi, "_") || "root") + "_full.png"));
b.close();
