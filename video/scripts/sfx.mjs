// Sound effects via ElevenLabs /v1/sound-generation -> public/audio/sfx/<name>.mp3
//   node scripts/sfx.mjs                      all missing
//   ONLY=tick,crack node scripts/sfx.mjs      force regenerate some
// The raw take is kept in .cache/sfx/<name>.mp3. The published file has its leading silence trimmed
// (so a cue lands on the frame it is placed at) and its peak brought to -1 dBTP.
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, post, retry } from "./env.mjs";

// name: [prompt, seconds]. Each 0.5 to 2 s. Names match what the scenes reference as audio/sfx/<name>.mp3.
const SFX = {
  tick: ["Single quiet dry clock tick, close, short, no reverb", 0.5],
  needle: ["A seismograph stylus swinging once across paper, a quick dry mechanical scratch with a tiny click, short", 0.8],
  "static-blip": ["Short burst of soft radio static, a brief electrical blip, clean, single", 0.7],
  crack: ["A dry sharp fracture, like a thin slab of stone cracking once, close, short, no reverb tail", 1.0],
  "key-click": ["Single soft laptop keyboard key click, close, dry, short", 0.5],
  "data-blip": ["Short clean telemetry chirp, a tiny rising digital blip, single, dry", 0.5],
  "whoosh-soft": ["Soft smooth airy whoosh, quiet cinematic transition, short, no music", 1.0],
  lock: ["A small metal latch closing with a firm satisfying click, single, close, dry", 0.7],
  redact: ["A single quick pen stroke on paper, a felt tip marker drawing one short line, close, dry", 0.7],
  "chime-resolve": ["Soft clean resolving chime, two gentle ascending notes landing on a warm tone, short tail", 1.5],
  "alarm-soft": ["Quiet muted electronic alarm beep, two short soft pulses, restrained, not harsh", 1.2],
  stamp: ["Firm rubber stamp pressed once onto paper, close, dry, single hit", 0.7],
  rewind: ["Short tape rewind, a quick reel spinning back then stopping with a soft click, clean", 1.5],
  riser: ["Short soft airy synth riser rising to a peak then cutting, clean, no drums", 2.0],
  "thud-soft": ["Soft low muted impact with a short warm sub tail, modern, quiet, single hit", 1.5],
  paper: ["A single sheet of paper sliding onto a desk, soft, close, dry", 0.8],
};

const dir = join(ROOT, "public/audio/sfx");
const raw = join(ROOT, ".cache/sfx");
mkdirSync(dir, { recursive: true });
mkdirSync(raw, { recursive: true });
const only = process.env.ONLY ? process.env.ONLY.split(",") : null;

const dur = (f) => parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", f]).toString());

// Trim leading silence (below -45 dB) and bring the peak to -1 dBTP; 44.1 kHz mp3 like the rest of the audio.
function publish(src, dst) {
  const trim = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02";
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", src, "-af", `${trim},volumedetect`, "-f", "null", "-"], { encoding: "utf8" });
  const m = r.stderr.match(/max_volume:\s*(-?[\d.]+) dB/);
  const gain = m ? (-1 - parseFloat(m[1])).toFixed(2) : "0";
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-af", `${trim},volume=${gain}dB`, "-ar", "44100", "-b:a", "128k", dst]);
  return gain;
}

for (const [name, [text, seconds]] of Object.entries(SFX)) {
  const f = join(dir, `${name}.mp3`);
  const r = join(raw, `${name}.mp3`);
  if (only ? !only.includes(name) : existsSync(f)) { console.log(`${name}: skip`); continue; }
  try {
    const buf = await retry(async () => {
      const res = await post("/sound-generation?output_format=mp3_44100_128", { text, duration_seconds: seconds, prompt_influence: 0.5 });
      return Buffer.from(await res.arrayBuffer());
    });
    writeFileSync(r, buf);
    const gain = publish(r, f);
    console.log(`${name}: ${(buf.length / 1024).toFixed(0)}kb, ${dur(f).toFixed(2)}s after trim, gain ${gain} dB`);
  } catch (e) { console.error(`${name}: FAILED ${e.message}`); }
}
