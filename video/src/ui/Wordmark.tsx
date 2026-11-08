import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { C, display } from "../theme";
import { clamp, expo } from "./motion";

/** The compact mark: one seismograph spike in a rounded square. */
export const Mark: React.FC<{ size?: number; bg?: string; fg?: string; style?: React.CSSProperties }> = ({ size = 64, bg = C.orange, fg = C.paperInk, style }) => (
  <svg width={size} height={size} viewBox="0 0 100 100" style={{ display: "block", ...style }}>
    <rect x={0} y={0} width={100} height={100} rx={22} fill={bg} />
    <polyline points="14,60 38,60 47,24 56,80 64,60 86,60" fill="none" stroke={fg} strokeWidth={9} strokeLinejoin="round" strokeLinecap="round" />
  </svg>
);

/**
 * The wordmark: FAULTLINE in Space Grotesk 700 with its baseline rule fractured, the second half
 * stepped down a few pixels and joined by a short vertical stroke. Static when `at` is omitted;
 * otherwise the halves slide in from either side at `at` and the rules draw on after.
 */
export const Wordmark: React.FC<{ size?: number; color?: string; accent?: string; at?: number; style?: React.CSSProperties }> = ({ size = 200, color = C.paperInk, accent = C.orange, at, style }) => {
  const f = useCurrentFrame();
  const p = at == null ? 1 : interpolate(f, [at, at + 16], [0, 1], { ...clamp, easing: expo });
  const rule = at == null ? 1 : interpolate(f, [at + 8, at + 26], [0, 1], { ...clamp, easing: expo });
  const offset = Math.round(size * 0.075);
  const stroke = Math.max(3, Math.round(size * 0.032));
  const gap = Math.round(size * 0.07);
  const half = (text: string, dir: -1 | 1): React.ReactNode => (
    <span style={{ position: "relative", top: dir === 1 ? offset : 0, display: "inline-block", lineHeight: 1, opacity: Math.min(1, p * 1.6), transform: `translateX(${(1 - p) * dir * size * 0.18}px)` }}>
      {text}
      <span style={{ position: "absolute", left: 0, right: 0, bottom: -gap, height: stroke, background: accent, transformOrigin: dir === -1 ? "100% 50%" : "0 50%", transform: `scaleX(${rule})` }} />
    </span>
  );
  return (
    <div style={{ display: "inline-flex", alignItems: "flex-end", fontFamily: display, fontWeight: 700, fontSize: size, letterSpacing: "-0.03em", color, whiteSpace: "nowrap", paddingBottom: gap + stroke + offset, ...style }}>
      {half("FAULT", -1)}
      <span style={{ display: "inline-block", width: stroke, height: offset + stroke, background: accent, marginBottom: -(gap + offset), opacity: rule > 0.9 ? 1 : 0 }} />
      {half("LINE", 1)}
    </div>
  );
};
