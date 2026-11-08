import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { C } from "../theme";
import { clamp, expo } from "./motion";

/** The fracture underline: a rule that steps down part way along, like the wordmark's baseline; drawn on with `p` (0..1). */
export const Fracture: React.FC<{ p: number; color?: string; thickness?: number; style?: React.CSSProperties }> = ({ p, color = C.orange, thickness = 4, style }) => (
  <svg viewBox="0 0 100 12" preserveAspectRatio="none" style={{ position: "absolute", left: 0, bottom: "-0.06em", width: "100%", height: "0.16em", overflow: "visible", clipPath: `inset(-20% ${(1 - p) * 100}% -20% 0)`, opacity: p > 0.01 ? 1 : 0, ...style }}>
    <polyline
      points="0,3 46,3 50,9.5 100,9.5"
      fill="none" stroke={color} strokeWidth={thickness} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round"
    />
  </svg>
);

const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9'→]/g, "");

/**
 * Kinetic type: each word rises and settles in turn from `at` (scene-local frames), `every` frames
 * apart. Same face and weight throughout; words named in `accent` get the orange fracture underline,
 * which draws on just after the word lands.
 */
export const Words: React.FC<{
  text: string; at: number; every?: number; dur?: number; accent?: string | string[]; accentColor?: string; out?: number; style?: React.CSSProperties;
}> = ({ text, at, every = 3, dur = 16, accent, accentColor = C.orange, out, style }) => {
  const f = useCurrentFrame();
  const words = text.split(" ").filter(Boolean);
  const acc = new Set((Array.isArray(accent) ? accent : accent ? [accent] : []).map(norm));
  const fade = out != null ? interpolate(f, [out, out + 8], [1, 0], clamp) : 1;
  return (
    <span style={{ display: "inline", opacity: fade, ...style }}>
      {words.map((w, i) => {
        const t = at + i * every;
        const p = interpolate(f, [t, t + dur], [0, 1], { ...clamp, easing: expo });
        const isAcc = acc.has(norm(w));
        const u = isAcc ? interpolate(f, [t + 8, t + 26], [0, 1], { ...clamp, easing: expo }) : 0;
        return (
          <span key={i} style={{ display: "inline-block", position: "relative", marginRight: "0.24em", opacity: Math.min(1, p * 1.5), transform: `translateY(${(1 - p) * 0.42}em)` }}>
            {w}
            {isAcc ? <Fracture p={u} color={accentColor} /> : null}
          </span>
        );
      })}
    </span>
  );
};
