import React from "react";
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from "remotion";
import { scene } from "../timing";
import { cue } from "../beats";
import { C, SCENE_TONE, TONE, Tone, display, mono, sans } from "../theme";
import { clamp, expo } from "../ui/motion";

/** Scene-local frame and word cues: rel("word", n) is when the nth "word" is spoken, scene-local. */
export function useCue(id: string) {
  const s = scene(id);
  const f = useCurrentFrame();
  const rel = (w: string, n = 0) => cue(id, w, n) - s.from;
  const toneName: Tone = SCENE_TONE[id] ?? "dark";
  return { s, f, rel, dur: s.durationInFrames, tone: TONE[toneName], toneName };
}

export const alpha = (hex: string, a: number) => {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
export const statusColor = (code: number) => (code >= 500 ? C.ember : code >= 400 ? C.amber : code >= 200 && code < 300 ? C.moss : C.sky);

export const Fill: React.FC<{ tone: Tone; children: React.ReactNode }> = ({ tone, children }) => (
  <AbsoluteFill style={{ background: TONE[tone].bg, color: TONE[tone].ink, fontFamily: sans, overflow: "hidden" }}>{children}</AbsoluteFill>
);

/** Small mono label with an orange square: what we are looking at. */
export const Kicker: React.FC<{ children: React.ReactNode; tone?: Tone; size?: number; style?: React.CSSProperties; dot?: string }> = ({ children, tone = "dark", size = 16, style, dot }) => (
  <div style={{ fontFamily: mono, fontSize: size, letterSpacing: "0.08em", color: TONE[tone].muted, display: "flex", alignItems: "center", gap: 12, whiteSpace: "nowrap", ...style }}>
    <span style={{ width: 9, height: 9, background: dot ?? (tone === "orange" ? C.paperInk : C.orange), flex: "none" }} />{children}
  </div>
);

/** Space Grotesk 700 headline, uppercase, tight. */
export const Head: React.FC<{ children: React.ReactNode; size?: number; style?: React.CSSProperties }> = ({ children, size = 120, style }) => (
  <div style={{ fontFamily: display, fontWeight: 700, fontSize: size, lineHeight: 0.96, letterSpacing: "-0.025em", textTransform: "uppercase", ...style }}>{children}</div>
);

export const In: React.FC<{ at: number; dur?: number; y?: number; x?: number; children: React.ReactNode; style?: React.CSSProperties; out?: number }> = ({ at, dur = 14, y = 18, x = 0, children, style, out }) => {
  const f = useCurrentFrame();
  const p = interpolate(f, [at, at + dur], [0, 1], { ...clamp, easing: expo });
  const o = out != null ? interpolate(f, [out, out + 8], [1, 0], clamp) : 1;
  return <div style={{ opacity: p * o, transform: `translate(${(1 - p) * x}px, ${(1 - p) * y}px)`, ...style }}>{children}</div>;
};

/** A flat plate (no blur, no pill): hairline border, optional 3 px accent bar on the left. */
export const Card: React.FC<{ at: number; left: number; top: number; width: number; height?: number; tone?: Tone; accent?: string | null; children: React.ReactNode; style?: React.CSSProperties; out?: number; pad?: string }> = ({ at, left, top, width, height, tone = "dark", accent = C.orange, children, style, out, pad = "18px 22px" }) => {
  const f = useCurrentFrame();
  const p = interpolate(f, [at, at + 14], [0, 1], { ...clamp, easing: expo });
  const o = out != null ? interpolate(f, [out, out + 8], [1, 0], clamp) : 1;
  const dark = tone === "dark";
  return (
    <div style={{
      position: "absolute", left, top, width, height, boxSizing: "border-box", opacity: p * o, transform: `translateY(${(1 - p) * 16}px)`,
      background: dark ? C.raised : tone === "paper" ? "#fbf9f4" : "rgba(20,19,17,0.08)", color: TONE[tone].ink, padding: pad, borderRadius: 4,
      boxShadow: `0 0 0 1px ${TONE[tone].line}`, borderLeft: accent ? `3px solid ${accent}` : undefined, fontFamily: sans, overflow: "hidden", ...style,
    }}>{children}</div>
  );
};

export const Chip: React.FC<{ children: React.ReactNode; color: string; size?: number; style?: React.CSSProperties; solid?: boolean }> = ({ children, color, size = 17, style, solid }) => (
  <span style={{ display: "inline-flex", alignItems: "center", fontFamily: mono, fontWeight: 600, fontSize: size, lineHeight: 1, padding: "6px 10px", borderRadius: 3, color: solid ? C.paperInk : color, background: solid ? color : alpha(color, 0.14), boxShadow: solid ? undefined : `inset 0 0 0 1px ${alpha(color, 0.7)}`, letterSpacing: "0.04em", whiteSpace: "nowrap", ...style }}>
    {children}
  </span>
);
export const Status: React.FC<{ code: number; size?: number; style?: React.CSSProperties; solid?: boolean }> = ({ code, size, style, solid }) => <Chip color={statusColor(code)} size={size} style={style} solid={solid}>{code}</Chip>;

/** Small honest label (mono, uppercase). */
export const Label: React.FC<{ children: React.ReactNode; tone?: Tone; style?: React.CSSProperties; size?: number }> = ({ children, tone = "dark", style, size = 13 }) => (
  <div style={{ fontFamily: mono, fontSize: size, letterSpacing: "0.1em", textTransform: "uppercase", color: TONE[tone].muted, ...style }}>{children}</div>
);

export const Mono: React.FC<{ children: React.ReactNode; size?: number; color?: string; style?: React.CSSProperties; weight?: number }> = ({ children, size = 18, color, style, weight = 400 }) => (
  <span style={{ fontFamily: mono, fontSize: size, fontWeight: weight, color, ...style }}>{children}</span>
);

/** A cut inside a scene: children see local frames from `from`. */
export const Cut: React.FC<{ from: number; until?: number; children: React.ReactNode }> = ({ from, until, children }) => (
  <Sequence from={from} durationInFrames={until != null ? Math.max(1, until - from) : undefined} layout="none">{children}</Sequence>
);

const TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?)|\b(true|false|null)\b/g;

/** Pretty JSON with light syntax colour; lines can appear one by one from `reveal`. */
export const Json: React.FC<{ text: string; size?: number; tone?: Tone; reveal?: number; perLine?: number; maxLines?: number; style?: React.CSSProperties; lineHeight?: number }> = ({ text, size = 18, tone = "dark", reveal, perLine = 3, maxLines = 12, style, lineHeight = 1.5 }) => {
  const f = useCurrentFrame();
  const dark = tone === "dark";
  const col = { key: dark ? C.muted : C.paperMuted, str: dark ? C.orangeInk : C.orange, num: dark ? C.sky : "#1f5f99", lit: C.amber, punct: dark ? C.faint : C.paperMuted };
  const lines = text.split("\n").slice(0, maxLines);
  const shown = reveal == null ? lines.length : Math.max(0, Math.floor((f - reveal) / perLine) + 1);
  return (
    <div style={{ fontFamily: mono, fontSize: size, lineHeight, whiteSpace: "pre-wrap", wordBreak: "break-word", color: TONE[tone].ink, ...style }}>
      {lines.slice(0, shown).map((line, i) => {
        const parts: React.ReactNode[] = [];
        let last = 0; let m: RegExpExecArray | null;
        TOKEN.lastIndex = 0;
        while ((m = TOKEN.exec(line))) {
          if (m.index > last) parts.push(<span key={`p${last}`} style={{ color: col.punct }}>{line.slice(last, m.index)}</span>);
          if (m[1] && m[2]) parts.push(<span key={`k${m.index}`} style={{ color: col.key }}>{m[1]}{m[2]}</span>);
          else if (m[1]) parts.push(<span key={`s${m.index}`} style={{ color: col.str }}>{m[1]}</span>);
          else if (m[3]) parts.push(<span key={`n${m.index}`} style={{ color: col.num }}>{m[3]}</span>);
          else parts.push(<span key={`l${m.index}`} style={{ color: col.lit }}>{m[4]}</span>);
          last = m.index + m[0].length;
        }
        if (last < line.length) parts.push(<span key={`t${last}`} style={{ color: col.punct }}>{line.slice(last)}</span>);
        return <div key={i}>{parts}</div>;
      })}
    </div>
  );
};

/** What stands in for a real value until data/session.json exists. Never styled like data. */
export const Pending: React.FC<{ what: string; tone?: Tone; style?: React.CSSProperties; compact?: boolean }> = ({ what, tone = "dark", style, compact }) => (
  <div style={{ fontFamily: mono, color: TONE[tone].muted, border: `1px dashed ${TONE[tone].muted}`, borderRadius: 4, padding: compact ? "8px 12px" : "14px 18px", display: "inline-block", ...style }}>
    <div style={{ fontSize: compact ? 12 : 13, letterSpacing: "0.12em", textTransform: "uppercase", color: TONE[tone].ink, opacity: 0.8 }}>awaiting session</div>
    <div style={{ fontSize: compact ? 12 : 14, marginTop: 4 }}>{what}</div>
  </div>
);
