import React from "react";
import { AbsoluteFill, random } from "remotion";
import { C, display, mono } from "./theme";
import { Mark, Wordmark } from "./ui/Wordmark";
import { Fracture } from "./ui/Words";

/** Thumbnail: the wordmark on the crack, the one measurement that matters, what it is. All copy from the README. */
export const Poster: React.FC = () => {
  const pts: string[] = [];
  for (let x = -20, i = 0; x <= 1940; x += 32, i++) {
    const step = x < 860 ? -22 : x > 1060 ? 22 : -22 + ((x - 860) / 200) * 44;
    pts.push(`${x},${(600 + step + (random(`p${i}`) - 0.5) * (x > 800 && x < 1120 ? 40 : 20)).toFixed(1)}`);
  }
  return (
    <AbsoluteFill style={{ background: C.bg, color: C.ink, fontFamily: display, overflow: "hidden" }}>
      <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
        <polyline points={pts.join(" ")} fill="none" stroke={C.orange} strokeWidth={7} strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div style={{ position: "absolute", left: 96, top: 92, display: "flex", alignItems: "flex-end", gap: 36 }}>
        <div style={{ paddingBottom: 40 }}><Mark size={120} /></div>
        <Wordmark size={176} color={C.ink} accent={C.orange} />
      </div>
      <div style={{ position: "absolute", left: 96, top: 372, fontSize: 60, fontWeight: 500, letterSpacing: "-0.015em", color: C.ink }}>
        A flight recorder for your API, <span style={{ position: "relative", display: "inline-block" }}>inside Hermes<Fracture p={1} /></span>
      </div>
      <div style={{ position: "absolute", left: 96, top: 690, display: "flex", alignItems: "baseline", gap: 30, fontWeight: 700, letterSpacing: "-0.04em", lineHeight: 1 }}>
        <span style={{ fontSize: 230, color: C.ember }}>500</span>
        <svg width={150} height={60} viewBox="0 0 150 60"><path d="M4 30 H136 M112 8 L136 30 L112 52" fill="none" stroke={C.ink} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" /></svg>
        <span style={{ fontSize: 230, color: C.moss }}>200</span>
      </div>
      <div style={{ position: "absolute", left: 1120, top: 760, width: 704, fontFamily: mono, fontSize: 24, lineHeight: 1.6, color: C.muted }}>
        <div style={{ color: C.ink, fontWeight: 600 }}>a plugin for Hermes Agent</div>
        <div>record · learn the contract</div>
        <div>break it on purpose · prove the fix</div>
      </div>
    </AbsoluteFill>
  );
};
