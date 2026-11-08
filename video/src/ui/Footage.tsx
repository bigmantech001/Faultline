import React from "react";
import { AbsoluteFill, Freeze, OffthreadVideo, interpolate, staticFile, useCurrentFrame } from "remotion";
import footage from "../footage.json";
import segments from "../segments.json";
import termPlan from "../../data/term_segments.json";
import studioPlan from "../../data/studio_segments.json";
import { C, mono, TONE, Tone } from "../theme";
import { clamp, expo, soft } from "./motion";

/**
 * Real footage of the session. src/footage.json is written by scripts/encode.mjs from the screencast
 * frames and .cache/marks.json: { "<clip>": { file, width, height, durationFrames, marks: { "<clip>.<beat>": clipFrame },
 * rects?: { "<name>": {x,y,w,h} in page CSS px }, segments?: [{from,to,speed}] } }.
 * Speed segments (for the honest "waits sped up Nx" label) come from, in order: footage.json's per-clip
 * `segments` (clip frames), src/segments.json { "<clip>": [{from,to,speed}] } (clip frames), or the
 * recording agent's plan data/<clip>_segments.json { segments: [{clip_from, clip_to, speed}], marks: {beat: {clip}} }
 * (clip seconds, as scripts/cast2player.mjs writes it). Everything is optional: a missing clip renders a
 * labelled placeholder, a missing mark falls back to a given frame.
 */
export interface Rect { x: number; y: number; w: number; h: number }
export interface Segment { from: number; to: number; speed: number }
export interface Clip { file: string; width: number; height: number; durationFrames: number; marks?: Record<string, number>; rects?: Record<string, Rect | null>; segments?: Segment[] }
interface Plan { segments?: { clip_from: number; clip_to: number; speed: number }[]; marks?: Record<string, { clip?: number }> }

const FPS = 30;
const LIB = footage as unknown as Record<string, Clip | undefined>;
const SEGS = segments as unknown as Record<string, Segment[] | undefined>;
const PLANS: Record<string, Plan | undefined> = { term: termPlan as unknown as Plan, studio: studioPlan as unknown as Plan };
const planSegments = (name: string): Segment[] | undefined => {
  const s = PLANS[name]?.segments;
  return s && s.length ? s.map((x) => ({ from: Math.round(x.clip_from * FPS), to: Math.round(x.clip_to * FPS), speed: x.speed })) : undefined;
};
const planMark = (name: string, beat: string): number | undefined => {
  const m = PLANS[name]?.marks;
  const v = m?.[beat]?.clip ?? m?.[beat.replace(`${name}.`, "")]?.clip;
  return typeof v === "number" ? Math.round(v * FPS) : undefined;
};

/** Beats each clip is expected to carry (the recording agent's marks). Used by the placeholder and the report. */
export const EXPECTED_MARKS: Record<string, string[]> = {
  term: ["term.proxy.started", "term.trace.read", "term.patch.applied", "term.replay.done", "term.chaos.added"],
  studio: ["studio.first_traces", "studio.drift_visible", "studio.replay.banner"],
};

export const clip = (name: string): Clip | undefined => LIB[name];
export const hasClip = (name: string): boolean => Boolean(LIB[name]?.file && (LIB[name]?.durationFrames ?? 0) > 0);

const warned = new Set<string>();
const warn = (k: string, msg: string) => { if (!warned.has(k)) { warned.add(k); console.warn(`[footage] ${msg}`); } };

/** Clip-local frame of a beat, given as "proxy.started" or "term.proxy.started"; `fallback` when the clip or mark is missing. */
export const markOf = (name: string, beat: string, fallback = 0): number => {
  const m = LIB[name]?.marks;
  const v = m?.[beat] ?? m?.[`${name}.${beat}`] ?? planMark(name, beat);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  warn(`${name}.${beat}`, `mark ${name}.${beat} missing; using ${fallback}`);
  return fallback;
};
/** startFrom so that `beat` lands on local frame `at` of the sequence the footage sits in. */
export const syncTo = (name: string, beat: string, at: number, fallback = 0): number => Math.max(0, markOf(name, beat, fallback) - at);
/** A measured element rect from footage.json (page CSS px), else the designer's guess. */
export const rectOf = (name: string, key: string, guess: Rect): Rect => LIB[name]?.rects?.[key] ?? LIB[name]?.rects?.[`${name}.${key}`] ?? guess;
/** Playback speed the recording was replayed at around clip frame `cf`, if the segments are known. */
export const speedAt = (name: string, cf: number): number | undefined => {
  const segs = LIB[name]?.segments ?? SEGS[name] ?? planSegments(name);
  if (!segs || !segs.length) return undefined;
  return segs.find((s) => cf >= s.from && cf < s.to)?.speed ?? segs[segs.length - 1].speed;
};

/** The page the footage was recorded at, in CSS pixels (3200x1800 at device scale 2). */
export const PAGE = { w: 1600, h: 900 };

/** A camera keyframe: at local frame `f`, centre on `rect` (page CSS px) at `z` times the fit-to-width scale. */
export interface Cam { f: number; rect?: Rect; z?: number; dx?: number; dy?: number }

function camAt(f: number, cams: Cam[], ph: number) {
  const pts = cams.map((c) => ({
    f: c.f, z: c.z ?? (c.rect ? 1.6 : 1),
    cx: (c.rect ? c.rect.x + c.rect.w / 2 : PAGE.w / 2) + (c.dx ?? 0),
    cy: (c.rect ? c.rect.y + c.rect.h / 2 : ph / 2) + (c.dy ?? 0),
  }));
  if (!pts.length) return { z: 1, cx: PAGE.w / 2, cy: ph / 2 };
  if (f <= pts[0].f) return pts[0];
  for (let i = 1; i < pts.length; i++) {
    if (f <= pts[i].f) {
      const a = pts[i - 1], b = pts[i];
      const t = interpolate(f, [a.f, b.f], [0, 1], { ...clamp, easing: soft });
      return { z: a.z + (b.z - a.z) * t, cx: a.cx + (b.cx - a.cx) * t, cy: a.cy + (b.cy - a.cy) * t };
    }
  }
  return pts[pts.length - 1];
}

const fmtSpeed = (s: number) => (Math.abs(s - Math.round(s)) < 0.05 ? String(Math.round(s)) : s.toFixed(1));

/**
 * A plate playing a recorded clip of the real session, with a camera that eases between keyframes
 * and a mono header carrying the honest label ("real session, waits sped up Nx"). The clip holds
 * its last frame if the scene outlasts it. Without the clip it renders a labelled placeholder.
 */
export const Footage: React.FC<{
  name: string; left: number; top: number; width: number; height: number;
  startFrom?: number; cams?: Cam[]; enter?: number; tag?: string; tone?: Tone; stopAt?: number; style?: React.CSSProperties; label?: boolean;
}> = ({ name, left, top, width, height, startFrom = 0, cams = [], enter = 0, tag, tone = "dark", stopAt, style, label = true }) => {
  const f = useCurrentFrame();
  const c = clip(name);
  const ok = hasClip(name);
  const tn = TONE[tone];
  const bar = 36;
  const vh = height - bar;
  const PH = c && c.width ? Math.round((PAGE.w * c.height) / c.width) : PAGE.h;
  const k = width / PAGE.w;
  const zMin = vh / (k * PH);
  const cam = camAt(f, cams, PH);
  const s = Math.max(zMin, cam.z);
  const tx = Math.min(0, Math.max(width - PAGE.w * k * s, width / 2 - cam.cx * k * s));
  const ty = Math.min(0, Math.max(vh - PH * k * s, vh / 2 - cam.cy * k * s));
  const inP = interpolate(f, [enter, enter + 16], [0, 1], { ...clamp, easing: expo });
  const last = c ? Math.min(c.durationFrames - 2, stopAt ?? Infinity) : 0;
  const pos = f + startFrom;
  const video = ok && c ? <OffthreadVideo src={staticFile(c.file)} startFrom={startFrom} muted style={{ width: PAGE.w, height: PH }} /> : null;
  const player = pos >= last ? <Freeze frame={Math.max(0, last - startFrom)}>{video}</Freeze> : video;
  const speed = ok ? speedAt(name, pos) : undefined;
  const honest = !ok ? "awaiting footage" : speed == null ? "real session" : speed > 1.02 ? `real session, waits sped up ${fmtSpeed(speed)}x` : "real session, real time";
  const dark = tone === "dark";
  return (
    <div style={{
      position: "absolute", left, top, width, height, overflow: "hidden", borderRadius: 4,
      background: dark ? C.deep : "#e9e4d8", boxShadow: `0 0 0 1px ${tn.line}`,
      opacity: inP, transform: `translateY(${(1 - inP) * 18}px)`, ...style,
    }}>
      <div style={{ height: bar, display: "flex", alignItems: "center", padding: "0 16px", gap: 12, fontFamily: mono, fontSize: 13, letterSpacing: "0.1em", textTransform: "uppercase", color: tn.muted, borderBottom: `1px solid ${tn.line}`, background: dark ? C.raised : "#e2dccf" }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: ok ? C.orange : C.faint }} />
        <span style={{ color: tn.ink, opacity: 0.85 }}>{tag ?? name}</span>
        <span style={{ flex: 1 }} />
        {label ? <span>{honest}</span> : null}
      </div>
      <div style={{ position: "relative", width, height: vh, overflow: "hidden" }}>
        {ok ? (
          <div style={{ position: "absolute", left: 0, top: 0, width: PAGE.w, height: PH, transformOrigin: "0 0", transform: `translate(${tx}px, ${ty}px) scale(${k * s})` }}>
            {player}
          </div>
        ) : (
          <Placeholder name={name} tone={tone} />
        )}
      </div>
    </div>
  );
};

/** What a missing clip looks like: unmistakably a placeholder, never mistaken for footage. */
const Placeholder: React.FC<{ name: string; tone: Tone }> = ({ name, tone }) => {
  const tn = TONE[tone];
  const dark = tone === "dark";
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", fontFamily: mono, color: tn.muted, background: dark ? C.deep : "#e9e4d8" }}>
      <svg width="100%" height="100%" style={{ position: "absolute", inset: 0, opacity: dark ? 0.12 : 0.18 }}>
        <defs>
          <pattern id={`grid-${name}`} width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke={tn.ink} strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#grid-${name})`} />
      </svg>
      <div style={{ position: "relative", textAlign: "center", padding: "18px 26px", border: `1px dashed ${tn.muted}`, borderRadius: 4, background: dark ? "rgba(11,11,10,0.7)" : "rgba(243,239,230,0.8)" }}>
        <div style={{ fontSize: 20, color: tn.ink, letterSpacing: "0.08em", textTransform: "uppercase" }}>awaiting footage</div>
        <div style={{ fontSize: 15, marginTop: 8 }}>public/footage/{name}.mp4</div>
        <div style={{ fontSize: 12, marginTop: 10, color: tn.muted, maxWidth: 520, lineHeight: 1.6 }}>{(EXPECTED_MARKS[name] ?? []).join("  ·  ")}</div>
      </div>
    </AbsoluteFill>
  );
};
