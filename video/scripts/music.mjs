// Music bed -> public/audio/music.mp3, sized to the film: src/timing.json totalFrames/30 + 2 s
// (or the sum of script.json scene seconds + 2 s until timing.json exists).
//   node scripts/music.mjs            (skips if music.mp3 exists at a length within 2 s of the target; FORCE=1 to redo)
// Path A: ElevenLabs Music API (POST /v1/music). Path B (fallback): several looped
// sound-generation beds stitched with ffmpeg crossfades. The bed is then loudness-normalised
// (two-pass loudnorm, -16 LUFS integrated like the narration, TP -1.5, LRA kept wide so the
// riser and the lift survive). Writes .cache/music.json { source, bpm, offsetSec, seconds, lufs, prompt }
// for timing.mjs (beats) and for the scene author (set the bed around -10 dB under speech).
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, post, retry } from "./env.mjs";
import { measure } from "./vofx.mjs";

const OUT = join(ROOT, "public/audio/music.mp3");
const META = join(ROOT, ".cache/music.json");
const RAW = join(ROOT, ".cache/music/raw.mp3");
mkdirSync(join(ROOT, ".cache/music"), { recursive: true });
const script = JSON.parse(readFileSync(join(ROOT, "script.json"), "utf8"));
const TIMING = join(ROOT, "src/timing.json");
const timing = existsSync(TIMING) ? JSON.parse(readFileSync(TIMING, "utf8")) : null;
const FPS = 30;
const filmSeconds = timing ? timing.totalFrames / FPS : script.scenes.reduce((n, s) => n + s.seconds, 0);
const seconds = Math.ceil(filmSeconds + 2);
const MUSIC_LUFS = -16;

// Scene start times in seconds, from timing.json when it exists, else from the script plan.
const starts = {};
{
  let t = 0;
  for (const s of script.scenes) {
    const ts = timing?.scenes.find((x) => x.id === s.id);
    starts[s.id] = ts ? ts.from / FPS : t;
    t += ts ? ts.durationInFrames / FPS : s.seconds;
  }
}
const at = (id) => Math.round(starts[id]);
const end = Math.round(filmSeconds);

// Restrained, instrumental, slightly tense. Cue points follow the film's scenes.
const PROMPT =
  `Restrained instrumental electronic score for a short developer tools film about a flight recorder for APIs, about 96 BPM, ` +
  `minimal and precise, no vocals, no lyrics, no epic drums, no cinematic hits. ` +
  `0-${at("turn") - 1}s: very sparse and slightly tense, a quiet ticking pulse like a clock or a seismograph needle, a low sustained dark synth pad, ` +
  `one faint repeating two-note motif, no drums. ${at("turn") - 1}-${at("turn")}s: a short soft airy riser. ` +
  `${at("turn")}-${at("record")}s: the riser lands on a warm, open held chord, calm and confident, the ticking continues quietly underneath. ` +
  `${at("record")}-${at("fix")}s: a cleaner steady groove, soft muted kick, tight quiet hi-hats, a round analog bass pulse, small clean plucks, ` +
  `methodical, like data being written to a tape. ` +
  `${at("fix")}-${at("chaos")}s: a lift, the chord rises a step, brighter plucks, a feeling of relief and proof, still restrained. ` +
  `${at("chaos")}-${at("close")}s: the groove continues but a little more tense, a filtered pulse and a faint alarm-like synth tone, then it settles. ` +
  `${at("close")}-${end}s: resolve on a warm final chord, the ticking slows and stops, one soft low note, then a short quiet tail into silence. ` +
  `No vocals, no lyrics, no big drum fills.`;

// Preferred path: a composition plan with one section per scene, each exactly as long as the timed
// scene, so the riser, the lift and the resolve land where the film needs them. The last section
// absorbs the +2 s tail so the final chord sustains under the end card.
function buildPlan() {
  const ms = (id) => {
    const ts = timing?.scenes.find((x) => x.id === id);
    return Math.round((ts ? ts.durationInFrames / FPS : script.scenes.find((s) => s.id === id).seconds) * 1000);
  };
  const local = {
    open: [["very sparse", "quiet", "slightly tense", "a quiet ticking clock pulse like a seismograph needle", "low dark sustained synth pad", "one faint repeating two-note motif", "no drums"], ["drums", "melody", "loud", "busy"]],
    turn: [["a short soft airy riser in the first second", "lands on a warm open held chord", "calm and confident", "the ticking continues quietly underneath"], ["drum fill", "big hit", "epic"]],
    record: [["a cleaner steady groove begins", "soft muted kick", "tight quiet hi-hats", "round analog bass pulse", "methodical like data being written to tape"], ["loud", "busy", "climax"]],
    see: [["the steady groove continues", "small clean plucks", "a hint of tension in the chord", "focused and precise"], ["drum fill", "climax", "loud"]],
    fix: [["a lift", "the chord rises a step", "brighter plucks", "relief and proof", "still restrained"], ["epic", "big drums", "cinematic hit"]],
    chaos: [["the groove continues slightly more tense", "a filtered pulse", "a faint alarm-like synth tone", "then it settles"], ["harsh", "loud", "distorted"]],
    close: [["resolve on a warm final chord that sustains to the very end", "the ticking slows and stops", "one soft low note", "a gentle fade in the last two seconds"], ["abrupt stop", "silence", "early ending", "drum fill"]],
  };
  const ids = script.scenes.map((s) => s.id);
  const sections = ids.map((id) => ({ section_name: id, duration_ms: ms(id), positive_local_styles: local[id]?.[0] ?? [], negative_local_styles: local[id]?.[1] ?? [], lines: [] }));
  const used = sections.reduce((n, s) => n + s.duration_ms, 0);
  sections.at(-1).duration_ms += seconds * 1000 - used; // the tail goes to the close
  return {
    positive_global_styles: ["restrained minimal electronic score", "instrumental", "about 96 bpm", "precise and clean", "quiet ticking pulse", "low sustained synth pad", "warm analog bass", "small clean plucks", "slightly tense", "modern developer tools film"],
    negative_global_styles: ["vocals", "lyrics", "epic drums", "cinematic hits", "orchestral", "big drum fills", "distorted guitars", "trap hi-hats", "dubstep"],
    sections,
  };
}

const ff = (a) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...a]);
const dur = (f) => parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", f]).toString());

// Rough BPM + first-beat offset from an onset envelope (low-passed energy, 10ms hops) via autocorrelation.
function detectBpm(file) {
  const raw = execFileSync("ffmpeg", ["-loglevel", "error", "-i", file, "-t", "60", "-ac", "1", "-ar", "8000", "-af", "lowpass=f=200", "-f", "s16le", "-"], { maxBuffer: 1 << 28 });
  const s = new Int16Array(raw.buffer, raw.byteOffset, raw.length >> 1);
  const hop = 80; // 10ms
  const env = [];
  for (let i = 0; i + hop <= s.length; i += hop) { let e = 0; for (let j = 0; j < hop; j++) e += s[i + j] * s[i + j]; env.push(Math.sqrt(e / hop)); }
  const on = env.map((v, i) => Math.max(0, v - (env[i - 1] ?? v)));
  let best = { bpm: 100, score: -1 };
  for (let bpm = 80; bpm <= 140; bpm += 0.5) {
    const lag = 6000 / bpm; // in 10ms hops
    let sc = 0;
    for (let i = 0; i + lag * 2 < on.length; i++) sc += on[i] * (on[Math.round(i + lag)] + on[Math.round(i + 2 * lag)]);
    if (sc > best.score) best = { bpm, score: sc };
  }
  // phase: best offset within one beat
  const lag = 6000 / best.bpm;
  let ph = { off: 0, sc: -1 };
  for (let o = 0; o < lag; o++) { let sc = 0; for (let t = o; t < on.length; t += lag) sc += on[Math.round(t)] || 0; if (sc > ph.sc) ph = { off: o, sc }; }
  return { bpm: best.bpm, offsetSec: +(ph.off / 100).toFixed(3) };
}

// Two-pass loudnorm of the raw bed to MUSIC_LUFS; wide LRA keeps the dynamics; a fade-out trims the end to the film.
function normalise(src, dst) {
  const ln = `loudnorm=I=${MUSIC_LUFS}:TP=-1.5:LRA=20`;
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", src, "-af", `${ln}:print_format=json`, "-f", "null", "-"], { encoding: "utf8" });
  const m = JSON.parse(r.stderr.slice(r.stderr.lastIndexOf("{"), r.stderr.lastIndexOf("}") + 1));
  const af = `${ln}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,atrim=0:${seconds},afade=t=out:st=${seconds - 1.5}:d=1.5`;
  ff(["-i", src, "-af", af, "-ar", "44100", "-b:a", "192k", dst]);
}

const prev = existsSync(META) ? JSON.parse(readFileSync(META, "utf8")) : null;
const fresh = existsSync(OUT) && prev && Math.abs((prev.seconds || 0) - seconds) <= 2;
if (fresh && !process.env.FORCE) {
  console.log(`music.mp3 exists at ${prev.seconds}s (target ${seconds}s, within 2 s; FORCE=1 to regenerate)`);
} else {
  if (existsSync(OUT) && prev && !fresh) console.log(`music.mp3 is ${prev.seconds}s but the film now needs ${seconds}s; regenerating`);
  let source;
  let plan = null;
  try {
    let buf = null;
    if (!process.env.NO_PLAN) {
      plan = buildPlan();
      try {
        buf = await retry(async () => {
          const res = await post("/music?output_format=mp3_44100_128", { composition_plan: plan });
          return Buffer.from(await res.arrayBuffer());
        }, 2);
        source = "elevenlabs-music-plan";
      } catch (e) {
        console.error(`composition plan rejected (${e.message.slice(0, 200)}); trying the prose prompt`);
        plan = null;
      }
    }
    if (!buf) {
      buf = await retry(async () => {
        const res = await post("/music?output_format=mp3_44100_128", { prompt: PROMPT, music_length_ms: seconds * 1000, force_instrumental: true });
        return Buffer.from(await res.arrayBuffer());
      }, 2);
      source = "elevenlabs-music";
    }
    writeFileSync(RAW, buf);
  } catch (e) {
    console.error(`Music API unavailable (${e.message.slice(0, 160)}); falling back to sound-generation beds`);
    const BEDS = [
      ["tick", "Quiet tense minimal electronic loop, a soft ticking clock pulse and a low sustained dark synth pad, 96 bpm, no drums, no vocals", 12],
      ["riser", "Short soft airy synth riser landing on a warm open held chord, 96 bpm, no drums, no vocals", 6],
      ["groove", "Clean steady minimal electronic groove loop, soft muted kick, tight quiet hi-hats, round analog bass pulse, small plucks, 96 bpm, no vocals", 22],
      ["lift", "Brighter uplifting minimal electronic groove loop, warm chords rising, clean plucks, restrained, 96 bpm, no vocals", 16],
      ["outro", "Soft resolving minimal electronic outro, warm final chord, slowing clock tick, one low note, short quiet tail, 96 bpm, no vocals", 12],
    ];
    const parts = [];
    for (const [n, text, d] of BEDS) {
      const f = join(ROOT, ".cache/music", `${n}.mp3`);
      if (!existsSync(f)) {
        const res = await retry(() => post("/sound-generation?output_format=mp3_44100_128", { text, duration_seconds: d, prompt_influence: 0.5 }));
        writeFileSync(f, Buffer.from(await res.arrayBuffer()));
      }
      parts.push(f);
    }
    const seg = (a, b) => Math.max(1, starts[b] - starts[a]);
    const segs = [
      [parts[0], seg("open", "turn") + 0.5],
      [parts[1], seg("turn", "record") + 0.5],
      [parts[2], seg("record", "fix") + 0.5],
      [parts[3], seg("fix", "close") + 0.5],
      [parts[4], seconds - starts.close],
    ];
    const inputs = segs.flatMap(([f]) => ["-stream_loop", "-1", "-i", f]);
    let fc = segs.map(([, d], i) => `[${i}:a]atrim=0:${d},asetpts=PTS-STARTPTS[s${i}]`).join(";");
    let p = "s0";
    for (let i = 1; i < segs.length; i++) { fc += `;[${p}][s${i}]acrossfade=d=1[x${i}]`; p = `x${i}`; }
    fc += `;[${p}]atrim=0:${seconds}[out]`;
    ff([...inputs, "-filter_complex", fc, "-map", "[out]", "-b:a", "192k", RAW]);
    source = "sound-generation-stitched";
  }
  normalise(RAW, OUT);
  const beat = detectBpm(OUT);
  const got = measure(OUT);
  writeFileSync(META, JSON.stringify({ source, ...beat, seconds, filmSeconds: +filmSeconds.toFixed(2), lufs: got.lufs, tp: got.tp, prompt: PROMPT, plan }, null, 1));
}
const meta = JSON.parse(readFileSync(META, "utf8"));
console.log(`music.mp3 ${dur(OUT).toFixed(1)}s (target ${seconds}s, film ${filmSeconds.toFixed(1)}s) via ${meta.source}; bpm ~${meta.bpm}, first beat ${meta.offsetSec}s; ${meta.lufs} LUFS, TP ${meta.tp}`);
console.log("re-run: node scripts/timing.mjs  (to write bpm/beats)");
