import { Rect, rectOf } from "./ui/Footage";

/**
 * Where the camera pushes, in the footage's page CSS pixels (1600x900). These are the designer's
 * guesses for an unseen recording; footage.json "rects" (measured by the capture scripts) override
 * them by key, so the recording agent can correct any of them without touching the scenes.
 */
const GUESS: Record<string, Rect> = {
  "term.proxy_url": { x: 24, y: 300, w: 980, h: 220 },
  "term.trace": { x: 24, y: 380, w: 1000, h: 320 },
  "term.patch": { x: 24, y: 300, w: 1000, h: 380 },
  "term.replay": { x: 24, y: 440, w: 1000, h: 300 },
  "term.chaos": { x: 24, y: 400, w: 1000, h: 300 },
  "studio.waterfall": { x: 120, y: 200, w: 760, h: 440 },
  "studio.trace_row": { x: 120, y: 270, w: 760, h: 70 },
  "studio.drift_finding": { x: 880, y: 300, w: 680, h: 320 },
  "studio.replay_banner": { x: 880, y: 150, w: 680, h: 130 },
  "studio.chaos_rules": { x: 880, y: 520, w: 680, h: 240 },
};

export const R = (key: keyof typeof GUESS): Rect => {
  const [clip] = key.split(".");
  return rectOf(clip, key, GUESS[key]);
};
