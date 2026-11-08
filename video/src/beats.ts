import { scene, wordAt } from "./timing";

const clean = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, "");

/**
 * Absolute frame of the nth `word` in a scene. Tolerant: if the voice timing tokenised the line
 * differently and the word is not there, fall back to where the word sits in the written line,
 * so a cue is never a crash.
 */
export const cue = (id: string, word: string, n = 0): number => {
  try {
    return wordAt(id, word, n);
  } catch {
    const s = scene(id);
    const words = s.lines.flatMap((l) => l.text.split(/\s+/)).filter(Boolean);
    const hits = words.map((w, i) => (clean(w) === clean(word) ? i : -1)).filter((i) => i >= 0);
    const idx = hits[n] ?? hits[0] ?? 0;
    const first = s.lines[0].startFrame;
    const lastLine = s.lines[s.lines.length - 1];
    const last = lastLine.words.length ? lastLine.words[lastLine.words.length - 1].end : s.from + s.durationInFrames;
    return Math.round(first + (idx / Math.max(1, words.length)) * (last - first));
  }
};

/** The motif's events, shared by the fault line and the sound table so they land together. */
export const SPIKE = cue("open", "five");                 // the 500
export const CRACK = cue("turn", "Faultline.");           // the fault line leaves the strip
export const BLIPS = Array.from({ length: 7 }, (_, i) => cue("record", "Every") + i * 9); // traffic landing (client.py "all": 7 requests)
export const BUMP = cue("chaos", "rate") + 4;             // the chaos 429
export const RESOLVE = cue("fix", "two");                 // 500 -> 200
