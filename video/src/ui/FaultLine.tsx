import React from "react";
import { AbsoluteFill, interpolate, random, useCurrentFrame } from "remotion";
import { C, FAULTLINE, SCENE_TONE, TONE } from "../theme";
import { T, scene } from "../timing";
import { BLIPS, BUMP, CRACK, RESOLVE, SPIKE } from "../beats";
import { clamp, expo } from "./motion";
import { Mark } from "./Wordmark";

/**
 * The motif: a seismograph trace pinned along the bottom 72 px of every scene. The paper scrolls
 * left under a pen at the right edge, so events stay on screen for ~16 s after they happen.
 * A red spike at "five hundred", a crack across the whole frame on the turn (the only time the
 * trace leaves the strip), small blips as traffic lands in record, an amber bump at the chaos 429,
 * and a flat green line from "two hundred" in fix. Rendered once at film level, in absolute frames.
 */
const W = 1920, H = 1080;
const STRIP = FAULTLINE.height;
const X0 = 150, X1 = W - 96;
const V = 3.6;   // px of paper per frame
const STEP = 4;  // px between samples

type Kind = "calm" | "spike" | "blip" | "bump" | "resolved";

function sample(t: number): { y: number; kind: Kind } {
  let y = Math.sin(t * 0.21) * 2.2 + Math.sin(t * 0.077 + 1.3) * 3.0 + (random(`fl${Math.round(t)}`) - 0.5) * 2.6;
  let kind: Kind = "calm";
  if (t >= RESOLVE) {
    const k = interpolate(t, [RESOLVE, RESOLVE + 26], [1, 0], clamp);
    y *= k;
    kind = "resolved";
  }
  const ts = t - SPIKE;
  if (ts >= 0 && ts < 44) {
    y -= 27 * Math.exp(-ts / 11) * Math.sin(ts * 1.1);
    kind = "spike";
  }
  for (const b of BLIPS) {
    const tb = t - b;
    if (tb >= 0 && tb < 10) { y -= 9 * (tb < 4 ? tb / 4 : 1 - (tb - 4) / 6); kind = kind === "calm" || kind === "resolved" ? "blip" : kind; }
  }
  const tu = t - BUMP;
  if (tu >= 0 && tu < 30) { y -= 17 * Math.sin((Math.PI * tu) / 30) + 3 * Math.sin(tu * 1.4) * (1 - tu / 30); kind = "bump"; }
  return { y, kind };
}

const turn = scene("turn");
const TURN_END = turn.from + turn.durationInFrames;

/** The crack: a jagged line across the frame with a fault step in the middle (deterministic). */
const CRACK_PTS = (() => {
  const pts: [number, number][] = [];
  for (let x = -20; x <= W + 20; x += 32) {
    const i = pts.length;
    const step = interpolate(x, [880, 1040], [-24, 24], clamp);
    const jag = (random(`crack${i}`) - 0.5) * (x > 820 && x < 1100 ? 44 : 22);
    pts.push([x, 548 + step + jag]);
  }
  return pts;
})();

export const FaultLine: React.FC = () => {
  const f = useCurrentFrame();
  const sc = T.scenes.find((s) => f >= s.from && f < s.from + s.durationInFrames) ?? T.scenes[T.scenes.length - 1];
  const toneName = SCENE_TONE[sc.id] ?? "dark";
  const tone = TONE[toneName];
  const onOrange = toneName === "orange";
  const colorOf = (k: Kind) => {
    if (k === "spike") return C.ember;
    if (k === "blip") return onOrange ? C.paperInk : C.orange;
    if (k === "bump") return onOrange ? C.paperInk : C.amber;
    if (k === "resolved") return onOrange ? "#0f6b47" : C.moss;
    return toneName === "dark" ? "rgba(184,177,164,0.7)" : toneName === "paper" ? "rgba(107,101,91,0.75)" : "rgba(20,19,17,0.7)";
  };
  const yMid = H - STRIP / 2;
  // runs of one colour
  const runs: { color: string; pts: string[] }[] = [];
  let head = { y: 0, kind: "calm" as Kind };
  for (let x = X0; x <= X1; x += STEP) {
    const t = f - (X1 - x) / V;
    const smp = sample(t);
    if (x + STEP > X1) head = smp;
    const color = colorOf(smp.kind);
    const pt = `${x},${(yMid + smp.y).toFixed(1)}`;
    const run = runs[runs.length - 1];
    if (run && run.color === color) run.pts.push(pt);
    else { if (run) run.pts.push(pt); runs.push({ color, pts: [pt] }); }
  }
  // the crack across the frame on the turn; the strip trace leaves while it is up
  const crackDraw = interpolate(f, [CRACK, CRACK + 18], [0, 1], { ...clamp, easing: expo });
  const crackVis = f >= CRACK - 4 && f < TURN_END + 8 ? interpolate(f, [CRACK - 4, CRACK, TURN_END - 10, TURN_END + 6], [0, 1, 1, 0], clamp) : 0;
  const stripVis = 1 - crackVis;
  const markVis = interpolate(f, [CRACK + 10, CRACK + 24], [0, 1], clamp);
  const penColor = colorOf(head.kind);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: STRIP, background: tone.strip, borderTop: `1px solid ${tone.line}` }} />
      <svg width={W} height={H} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        <g opacity={stripVis}>
          {runs.map((r, i) => (
            <polyline key={i} points={r.pts.join(" ")} fill="none" stroke={r.color} strokeWidth={FAULTLINE.stroke} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          <circle cx={X1} cy={yMid + head.y} r={9} fill={penColor} opacity={0.22} />
          <circle cx={X1} cy={yMid + head.y} r={4} fill={penColor} />
        </g>
        {crackVis > 0 ? (
          <polyline points={CRACK_PTS.map(([x, y]) => `${x},${y.toFixed(1)}`).join(" ")} fill="none" stroke={onOrange ? C.paperInk : C.orange} strokeWidth={6}
            strokeLinejoin="round" strokeLinecap="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - crackDraw} opacity={crackVis} />
        ) : null}
      </svg>
      <div style={{ position: "absolute", left: 96, bottom: (STRIP - 30) / 2, opacity: markVis, transform: `scale(${0.8 + 0.2 * markVis})`, transformOrigin: "0 100%" }}>
        <Mark size={30} bg={onOrange ? C.paperInk : C.orange} fg={onOrange ? C.orange : C.paperInk} />
      </div>
    </AbsoluteFill>
  );
};
