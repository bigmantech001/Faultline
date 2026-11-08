import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { C, mono, SCENE_TONE, TONE } from "../theme";
import { T } from "../timing";
import { clamp } from "./motion";

/**
 * Narration as a mono lower-third ticker: one line, left-aligned, the current phrase with words
 * lighting up as they are spoken and an orange block cursor after the last one. Hidden where the
 * big type already carries the words.
 */
export const Ticker: React.FC<{ hidden?: (frame: number) => boolean; bottom?: number; left?: number }> = ({ hidden, bottom = 92, left = 96 }) => {
  const frame = useCurrentFrame();
  if (hidden?.(frame)) return null;
  const sc = T.scenes.find((s) => frame >= s.from && frame < s.from + s.durationInFrames);
  const line = T.scenes.flatMap((s) => s.lines).find((l) => frame >= l.startFrame - 4 && frame <= l.words[l.words.length - 1].end + 14);
  if (!line || !sc) return null;
  const tone = TONE[SCENE_TONE[sc.id] ?? "dark"];
  const chunks: (typeof line.words)[] = [];
  let cur: typeof line.words = [];
  for (const w of line.words) {
    cur.push(w);
    if ((/[.:;?!]$/.test(w.word) && cur.length >= 3) || (/,$/.test(w.word) && cur.length >= 6) || cur.length >= 9) { chunks.push(cur); cur = []; }
  }
  if (cur.length) chunks.push(cur);
  let shown = chunks[0];
  for (const c of chunks) if (frame >= c[0].start - 3) shown = c;
  const lastEnd = line.words[line.words.length - 1].end;
  const op = interpolate(frame, [line.startFrame - 4, line.startFrame + 2, lastEnd + 6, lastEnd + 14], [0, 1, 1, 0], clamp);
  const spoken = shown.filter((w) => frame >= w.start - 2).length;
  const blink = Math.floor(frame / 9) % 2 === 0 ? 1 : 0.25;
  return (
    <div style={{ position: "absolute", left, bottom, display: "flex", alignItems: "center", gap: 0, opacity: op, pointerEvents: "none", fontFamily: mono, fontSize: 25, fontWeight: 500, letterSpacing: "0.005em", whiteSpace: "nowrap" }}>
      <span style={{ width: 4, height: 24, background: C.orange, marginRight: 16, opacity: 0.9 }} />
      {shown.map((w, i) => (
        <span key={i} style={{ color: i < spoken ? tone.ink : tone.muted, opacity: i < spoken ? 1 : 0.6, marginRight: "0.55em" }}>{w.word}</span>
      ))}
      <span style={{ display: "inline-block", width: 13, height: 26, background: C.orange, marginLeft: -8, opacity: blink }} />
    </div>
  );
};
