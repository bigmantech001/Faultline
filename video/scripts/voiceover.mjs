// Voice-over for every line in script.json, via ElevenLabs /with-timestamps.
//   node scripts/voiceover.mjs                  generate changed/missing lines (hash cache)
//   ONLY=see_0,fix_0 node scripts/voiceover.mjs  force one or more ids (comma list)
// Outputs:
//   public/audio/vo/<sceneId>_<i>.mp3        (what the film plays; loudness-normalised to -16 LUFS)
//   .cache/raw/<sceneId>_<i>.mp3             (untouched take; timing.mjs may atempo from it)
//   .cache/words/<sceneId>_<i>.json          (word timings in seconds, from char alignment of the spoken text)
//   .cache/vo.json                           (hash per line + characters consumed log)
// A line's `say` field is what is sent to the voice (phonetic spelling, e.g. "Fault-line", "A P I");
// `text` is what the film shows. timing.mjs maps the spoken words back onto the written ones.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ROOT, post, retry } from "./env.mjs";
import { renderVo } from "./vofx.mjs";

const script = JSON.parse(readFileSync(join(ROOT, "script.json"), "utf8"));
const OUT = join(ROOT, "public/audio/vo");
const RAW = join(ROOT, ".cache/raw");
const WORDS = join(ROOT, ".cache/words");
const CACHE = join(ROOT, ".cache/vo.json");
for (const d of [OUT, RAW, WORDS]) mkdirSync(d, { recursive: true });
const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : { lines: {}, charsUsed: 0 };

// Per-line performance direction for this film (merged over the voice settings in script.json).
// The incident open is read plainly with a little tension; the title turn and the close are
// slower and settled; everything else uses the script defaults.
const OVERRIDES = {
  open_0: { stability: 0.55, style: 0.25, speed: 1.1 },
  see_0: { speed: 1.1 },
  turn_0: { stability: 0.6, style: 0.25, speed: 0.98 },
  close_0: { stability: 0.6, style: 0.25, speed: 0.96 },
};

const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
// TAKES=3 generates several takes of each (re)generated line and keeps the shortest one whose rate is sane.
const TAKES = Math.max(1, parseInt(process.env.TAKES || "1", 10));

export const durationOf = (f) =>
  parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", f]).toString());

function toWords(a) {
  const words = [];
  let cur = null;
  a.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) { if (cur) { words.push(cur); cur = null; } return; }
    if (!cur) cur = { word: "", start: a.character_start_times_seconds[i], end: 0 };
    cur.word += ch;
    cur.end = a.character_end_times_seconds[i];
  });
  if (cur) words.push(cur);
  return words;
}

async function synth(text, voiceId, settings) {
  return retry(async () => {
    const res = await post(`/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`, {
      text, model_id: script.model, voice_settings: settings,
    });
    const body = await res.json();
    return { audio: Buffer.from(body.audio_base64, "base64"), words: toWords(body.alignment) };
  });
}

// Speech rate sanity: a normal read is ~11-18 chars/sec of speech (measured first word to last word).
const sane = (text, words) => {
  const speech = words.at(-1).end - words[0].start;
  const cps = text.length / speech;
  return { ok: cps >= 8 && cps <= 21, cps, speech };
};

let used = 0;
for (const scene of script.scenes) {
  for (const [i, line] of scene.lines.entries()) {
    const id = `${scene.id}_${i}`;
    const voice = script.voices[line.voice];
    const settings = { ...voice.settings, ...(OVERRIDES[id] || {}) };
    const spoken = line.say ?? line.text;
    const hash = createHash("sha1").update(JSON.stringify([spoken, voice.id, settings, script.model])).digest("hex");
    const have = existsSync(join(OUT, `${id}.mp3`)) && existsSync(join(WORDS, `${id}.json`));
    if (have && cache.lines[id]?.hash === hash && !(only && only.includes(id))) { console.log(`${id}: cached`); continue; }
    if (only && !only.includes(id) && have) continue;

    const takes = [];
    const grab = async () => {
      const t = await synth(spoken, voice.id, settings);
      used += spoken.length; // ElevenLabs bills the characters actually sent
      takes.push({ ...t, chk: sane(line.text, t.words) });
    };
    for (let k = 0; k < TAKES; k++) await grab();
    if (!takes.some((t) => t.chk.ok)) { console.log(`${id}: ${takes[0].chk.cps.toFixed(1)} cps looks off, retaking once`); await grab(); }
    const pool = takes.filter((t) => t.chk.ok).length ? takes.filter((t) => t.chk.ok) : takes;
    const take = pool.reduce((a, b) => (b.chk.speech < a.chk.speech ? b : a));
    const chk = take.chk;
    if (takes.length > 1) console.log(`${id}: takes ${takes.map((t) => t.chk.speech.toFixed(2) + "s").join(" ")} -> kept ${chk.speech.toFixed(2)}s`);
    writeFileSync(join(RAW, `${id}.mp3`), take.audio);
    renderVo(id, 1);
    writeFileSync(join(WORDS, `${id}.json`), JSON.stringify({ tempo: 1, spoken, words: take.words }, null, 1));
    const dur = durationOf(join(OUT, `${id}.mp3`));
    cache.lines[id] = { hash, voice: voice.id, chars: spoken.length, dur, speech: +chk.speech.toFixed(2), cps: +chk.cps.toFixed(1) };
    console.log(`${id}: ${dur.toFixed(2)}s file, ${chk.speech.toFixed(2)}s speech, ${chk.cps.toFixed(1)} cps  [${line.voice}/${voice.id}]`);
  }
}
cache.charsUsed = (cache.charsUsed || 0) + used;
writeFileSync(CACHE, JSON.stringify(cache, null, 1));
const total = Object.values(cache.lines).reduce((n, l) => n + (l.dur || 0), 0);
console.log(`chars this run: ${used}, total logged: ${cache.charsUsed}; narration files sum ${total.toFixed(1)}s`);
