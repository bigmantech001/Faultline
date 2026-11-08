// Drives the Hermes Desktop workspace ("Webapp", served by the film home's gateway at :9121) in
// headless Chrome: signs in with the one-use link `hermes webapp --no-open --skip-build` prints,
// turns the faultline Desktop half on in Capabilities -> Plugins, opens the Faultline Studio page
// (/faultline) and then either
//   probe   : dumps what the page says and takes stills (to learn the DOM before the real take), or
//   record  : screencasts the Studio page into .cache/frames/<CLIP>/ (frames.json, epoch seconds)
//             until the control file says "stop", taking marks (epoch seconds) when the page first
//             shows each beat (first trace, first 5xx, replay banner, chaos rule, ...) and whenever
//             the control file carries a `mark <name>` line. Marks go to .cache/marks.json as
//             `<CLIP>.<beat>` (encode.mjs/Footage.tsx contract).
//
//   node scripts/studio.mjs probe  <outdir>
//   CLIP=studio node scripts/studio.mjs record <ctlfile> <outdir>
// The control file is a plain text file this script tails, one command per line:
//   mark <name>      note the time as <CLIP>.<name>
//   still <name>     PNG of the page into .cache/frames/<CLIP>-stills/<name>.png (+ `text <name>` for its innerText)
//   click <text>     click the deepest element whose text is exactly <text> (a trace row's status, a button...)
//   js <expression>  run JS in the page (e.g. click one row's Replay button)
//   stop             end the screencast
// It writes `<ctlfile>.ready` once the Studio page is up, so the terminal take can start in step with it.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launch, sleep } from "./cdp.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const FILM_HOME = "/private/tmp/claude-501/-Users-bigmantech001-Faultline/24ea2fa7-aaf2-4fa6-8efe-c0431050eb42/scratchpad/film-home";
const HERMES = "hermes";
const CLIP = process.env.CLIP || "studio";
const W = Number(process.env.W || 1600), H = Number(process.env.H || 900);
const mode = process.argv[2] || "probe";
const arg1 = process.argv[3];
const arg2 = process.argv[4];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function launchLink() {
  const out = execFileSync(HERMES, ["webapp", "--no-open", "--skip-build"], {
    env: { ...process.env, HERMES_HOME: FILM_HOME }, encoding: "utf8", timeout: 60000,
  });
  const m = out.match(/http:\/\/127\.0\.0\.1:9121\/\S+/);
  if (!m) throw new Error("no launch link in: " + out.replace(/ticket=\S+/g, "ticket=[hidden]").slice(0, 400));
  return m[0];
}

const b = await launch({ width: W, height: H, extraArgs: ["--force-device-scale-factor=2"] });
process.on("exit", () => { try { b.close(); } catch {} });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(1));
await b.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: false });
const text = () => b.js("document.body.innerText");
// Click like a pointer would: the deepest element whose own text is `t`, then the nearest clickable ancestor.
const clickText = (t, exact = true) => b.js(`(() => { const hits = [...document.querySelectorAll('a,button,[role=button],[role=tab],[role=menuitem],div,span,li,p')].filter(e => e.children.length < 4 && (${exact} ? e.textContent.trim() === ${JSON.stringify(t)} : e.textContent.trim().startsWith(${JSON.stringify(t)}))); if (!hits.length) return false; const leaf = hits[hits.length - 1]; const el = leaf.closest('a,button,[role=button],[role=tab],[role=menuitem],[role=link]') || leaf; for (const type of ['pointerdown','mousedown','pointerup','mouseup']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); el.click(); return el.tagName })()`);

const link = launchLink();
log("signing in");
await b.goto(link, 8000);
log("url", (await b.js("location.href")).replace(/ticket=\S+/, "ticket=[hidden]"));
// The plugin inventory needs the backend connection; wait for the status bar to say so.
for (let i = 0; i < 15 && !/Backend\s*\n?\s*ready/.test(await text()); i++) await sleep(1000);
log("backend:", ((await text()).match(/Backend\s*\n?\s*(\w+)/) || [])[1]);

// Capabilities -> Plugins -> faultline row -> Desktop switch on.
log("Capabilities:", await clickText("Capabilities")); await sleep(2500);
log("Plugins:", await clickText("Plugins")); await sleep(2500);
const rowInfo = () => b.js(`(() => {
  const leaf = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && /^Faultline$|^faultline$/.test(e.textContent.trim()));
  if (!leaf) return { found: false };
  let card = leaf; for (let k = 0; k < 6 && card && !card.querySelector('[role=switch], button[aria-checked]'); k++) card = card.parentElement;
  const sws = card ? [...card.querySelectorAll('[role=switch], button[aria-checked]')] : [];
  return { found: true, switches: sws.map(s => ({ checked: s.getAttribute('aria-checked'), label: (s.getAttribute('aria-label') || s.closest('label')?.textContent || s.parentElement?.textContent || '').trim().slice(0, 60) })), text: card ? card.innerText.replace(/\\n+/g, ' | ').slice(0, 600) : '' };
})()`);
log("search:", await b.js(`(() => { const i = document.querySelector('input[placeholder*="Search plugins"]'); if (!i) return false; i.focus(); return true })()`));
await b.send("Input.insertText", { text: "faultline" }); await sleep(1500);
for (let i = 0; i < 20 && !(await rowInfo()).found; i++) await sleep(1000);
let row = await rowInfo();
log("row before:", JSON.stringify(row));
// Turn on every switch in the row that is off (Desktop is the one that matters; Agent is already enabled).
const flipped = await b.js(`(() => {
  const leaf = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && /^Faultline$|^faultline$/.test(e.textContent.trim()));
  if (!leaf) return 'no row';
  let card = leaf; for (let k = 0; k < 6 && card && !card.querySelector('[role=switch], button[aria-checked]'); k++) card = card.parentElement;
  const sws = card ? [...card.querySelectorAll('[role=switch], button[aria-checked]')] : [];
  const out = [];
  for (const s of sws) { const lbl = (s.getAttribute('aria-label') || s.parentElement?.textContent || '').toLowerCase(); if (s.getAttribute('aria-checked') !== 'true' && /desktop/.test(lbl)) { s.click(); out.push('clicked ' + lbl.slice(0, 30)); } }
  if (!out.length) for (const s of sws) { if (s.getAttribute('aria-checked') !== 'true') { s.click(); out.push('clicked (unlabelled)'); } }
  return out.join('; ') || 'nothing to flip';
})()`);
log("flip:", flipped); await sleep(4000);
row = await rowInfo();
log("row after:", JSON.stringify(row));
if (/copying/i.test(row.text || "")) { log("Rescan:", await clickText("Rescan")); await sleep(5000); row = await rowInfo(); log("row after rescan:", JSON.stringify(row)); }

const sidebarHasFaultline = async () => /\bFaultline\b/.test(await b.js(`(() => { const nav = document.querySelector('nav, aside, [role=navigation]'); return nav ? nav.innerText : '' })()`));
log("sidebar Faultline:", await sidebarHasFaultline());
log("open studio:", await clickText("Faultline")); await sleep(2500);
if (!/faultline/.test(await b.js("location.hash + location.pathname"))) { await b.js("location.hash = '#/faultline'"); await sleep(3000); }
log("location:", await b.js("location.hash + ' ' + location.pathname"));
const chip = await b.js(`(() => { const el = [...document.querySelectorAll('span,div')].find(e => e.children.length < 3 && /^Faultline: \\d+ traces/.test(e.textContent.trim())); return el ? el.textContent.trim() : null })()`);
log("chip:", chip);

if (mode === "probe") {
  const out = arg1 || join(ROOT, ".cache/probe");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "studio.txt"), await text());
  await b.shot(join(out, "studio.png"));
  log("rects:", JSON.stringify({ sidebar: await b.rect("nav, aside"), main: await b.rect("main") }));
  log("wrote", out);
  b.close();
  process.exit(0);
}

// record: screencast until the control file says stop; DOM-detected and control-file marks.
const ctl = arg1 || join(ROOT, ".cache/studio.ctl");
const outdir = arg2 || join(ROOT, ".cache/frames", CLIP);
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
writeFileSync(ctl, "");
const marks = {};
const mark = (k) => { if (!(k in marks)) { marks[k] = Date.now() / 1000; log("mark", k); } };
// Beats the page itself shows; the regexes are matched against body.innerText at every poll.
const DETECT = [
  ["first.trace", /Captured Traces\s*\n\s*[1-9]/],            // stats card leaves 0
  ["fault", /5xx Server Faults\s*\n\s*[1-9]/],
  ["drift", /OpenAPI Schema Drifts\s*\n\s*[1-9]/],
  ["routes", /Learned OpenAPI Routes\s*\n\s*[1-9]/],
  ["chip.fault", /Faultline: \d+ traces · \d+ server fault/],   // status-bar chip turns red
  ["inspector", /Trace Inspector \(flt-/],                      // a row was opened
  ["replay.row", /\n\s*200\s*\n\s*POST\s*\n\s*\/api\/v1\/checkout\s*\n\s*replay/], // the agent's replay trace listed
  ["replay.banner", /Deterministic Replay Verified|BUG RESOLVED/],
  ["chaos.row", /\n\s*429\s*\n\s*POST\s*\n\s*\/api\/v1\/webhooks\/stripe/],
];
const stop = await b.screencast(outdir);
mark("start");
writeFileSync(ctl + ".ready", String(Date.now() / 1000));
let seen = 0;
const stillsDir = join(outdir, "..", `${CLIP}-stills`);
mkdirSync(stillsDir, { recursive: true });
for (;;) {
  let t = "";
  try { t = await text(); } catch {}
  for (const [k, re] of DETECT) if (re.test(t)) mark(k);
  const lines = existsSync(ctl) ? readFileSync(ctl, "utf8").split("\n").filter(Boolean) : [];
  let done = false;
  for (const line of lines.slice(seen)) {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    if (cmd === "mark") mark(rest.join(" "));
    else if (cmd === "click") { try { log("click", rest.join(" "), "->", await clickText(rest.join(" "))); } catch (e) { log("click failed", e.message); } }
    else if (cmd === "js") { try { log("js ->", JSON.stringify(await b.js(rest.join(" "))).slice(0, 200)); } catch (e) { log("js failed", e.message); } }
    else if (cmd === "still") { try { await b.shot(join(stillsDir, `${rest.join("_") || Date.now()}.png`)); log("still", rest.join(" ")); } catch (e) { log("still failed", e.message); } }
    else if (cmd === "text") { try { writeFileSync(join(stillsDir, `${rest.join("_") || Date.now()}.txt`), await text()); } catch {} }
    else if (cmd === "stop") done = true;
  }
  seen = lines.length;
  if (done) break;
  await sleep(400);
}
mark("stop");
await stop();
const mp = join(ROOT, ".cache/marks.json");
const all = existsSync(mp) ? JSON.parse(readFileSync(mp, "utf8")) : {};
for (const [k, v] of Object.entries(marks)) all[`${CLIP}.${k}`] = v;
writeFileSync(mp, JSON.stringify(all, null, 1));
writeFileSync(join(outdir, "marks_epoch.json"), JSON.stringify(marks, null, 1));
log("done", Object.keys(marks).length, "marks");
b.close();
process.exit(0);
