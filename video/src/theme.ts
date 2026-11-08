import { loadFont as loadGrotesk } from "@remotion/google-fonts/SpaceGrotesk";
import { loadFont as loadMono } from "@remotion/google-fonts/IBMPlexMono";

/**
 * Faultline film theme. Deliberately unlike an earlier film: no navy, no electric blue, no condensed
 * display face, no italic serif accents, no frosted pills.
 *
 * Display and body: Space Grotesk. Code, tickers, captions: IBM Plex Mono. Accent words are not a
 * different typeface; they carry an orange "fracture" underline (see ui/Words).
 */
export const grotesk = loadGrotesk("normal", { weights: ["400", "500", "700"], subsets: ["latin"] }).fontFamily;
export const mono = loadMono("normal", { weights: ["400", "500", "600"], subsets: ["latin"] }).fontFamily;
export const display = grotesk;
export const sans = grotesk;

/** Palette: a flight recorder is orange; the rest is charcoal, smoke and warm paper. */
export const C = {
  bg: "#141311",          // charcoal
  deep: "#0b0b0a",
  raised: "#1e1c19",
  ink: "#f3efe6",         // warm paper white
  muted: "#b8b1a4",
  faint: "#7d776c",
  line: "rgba(243, 239, 230, 0.14)",
  orange: "#ff6a1a",      // recorder orange (the fault line)
  orangeInk: "#ffb08a",
  ember: "#ff3b1f",       // 5xx
  amber: "#ffb020",       // 4xx / chaos
  moss: "#3ddc97",        // 2xx / resolved
  sky: "#7cc4ff",         // informational (method names)
  paper: "#f3efe6",
  paperInk: "#141311",
  paperMuted: "#6b655b",
  paperLine: "rgba(20, 19, 17, 0.12)",
};

export type Tone = "dark" | "paper" | "orange";
export const TONE: Record<Tone, { bg: string; ink: string; muted: string; line: string; strip: string }> = {
  dark: { bg: C.bg, ink: C.ink, muted: C.muted, line: C.line, strip: "rgba(11, 11, 10, 0.82)" },
  paper: { bg: C.paper, ink: C.paperInk, muted: C.paperMuted, line: C.paperLine, strip: "rgba(243, 239, 230, 0.9)" },
  orange: { bg: C.orange, ink: C.paperInk, muted: "rgba(20, 19, 17, 0.7)", line: "rgba(20, 19, 17, 0.2)", strip: "rgba(255, 106, 26, 0.85)" },
};

/** Scene tones: dark for the incident, orange for the turn, paper for the proof, dark to close. */
export const SCENE_TONE: Record<string, Tone> = {
  open: "dark",
  turn: "orange",
  record: "dark",
  see: "dark",
  fix: "paper",
  chaos: "dark",
  close: "orange",
};

/** The recurring motif: a seismograph trace that runs along the bottom of every scene. */
export const FAULTLINE = {
  height: 72,            // px reserved at the bottom for the trace strip
  stroke: 3,
  calm: C.muted,
  spike5xx: C.ember,
  spike4xx: C.amber,
  resolved: C.moss,
};
