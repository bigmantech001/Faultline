// Checks each VO clip: file duration, speech span, chars/sec from the alignment, then a transcript
// from ElevenLabs speech-to-text printed under the script line, to catch misreads (names, acronyms).
//   node scripts/vocheck.mjs [id ...]        NOSTT=1 to skip the transcription
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, key, API } from "./env.mjs";
const script = JSON.parse(readFileSync(join(ROOT, "script.json"), "utf8"));
const want = process.argv.slice(2);
const dur = (f) => parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", f]).toString());
let total = 0;
for (const s of script.scenes) for (const [i, l] of s.lines.entries()) {
  const id = `${s.id}_${i}`;
  if (want.length && !want.includes(id)) continue;
  const file = join(ROOT, "public/audio/vo", `${id}.mp3`);
  if (!existsSync(file)) { console.log(`${id}: missing`); continue; }
  const d = dur(file);
  total += d;
  const w = JSON.parse(readFileSync(join(ROOT, ".cache/words", `${id}.json`), "utf8")).words;
  const speech = w.at(-1).end - w[0].start;
  const cps = l.text.length / speech;
  const flag = cps < 11 || cps > 18 ? "  <-- rate outside 11-18 cps" : "";
  console.log(`${id}: ${d.toFixed(2)}s file, ${speech.toFixed(2)}s speech, ${cps.toFixed(1)} cps, ${w.length} words, planned ${s.seconds}s${flag}`);
  console.log(`  script: ${l.text}`);
  if (process.env.NOSTT) continue;
  const fd = new FormData();
  fd.append("model_id", "scribe_v1");
  fd.append("file", new Blob([readFileSync(file)]), `${id}.mp3`);
  const res = await fetch(`${API}/speech-to-text`, { method: "POST", headers: { "xi-api-key": key }, body: fd });
  const body = await res.json();
  console.log(`  heard:  ${res.ok ? body.text : JSON.stringify(body).slice(0, 200)}`);
}
console.log(`narration total ${total.toFixed(2)}s across files`);
