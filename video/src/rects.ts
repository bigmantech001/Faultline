import { Rect, rectOf } from "./ui/Footage";

/**
 * Where the camera pushes, in the footage's page CSS pixels (1600x900). These are the designer's
 * guesses for an unseen recording; footage.json "rects" (measured by the capture scripts) override
 * them by key, so the recording agent can correct any of them without touching the scenes.
 */
// Measured on the real footage (scripts/encode.mjs output, ffmpeg -vf select at each clip's mark
// frame; page is 1600x900 CSS, the screencast is 3200x1800 at device scale 2).
const GUESS: Record<string, Rect> = {
  "term.proxy_url": { x: 24, y: 40, w: 1120, h: 130 },   // "Proxy URL to point the storefront at: http://127.0.0.1:8700"
  "term.trace": { x: 24, y: 16, w: 1180, h: 150 },       // POST /api/v1/checkout -> 500, ZeroDivisionError detail
  "term.patch": { x: 24, y: 120, w: 1200, h: 360 },      // the diff: new signature + the net_payable_cents <= 0 guard
  "term.replay": { x: 24, y: 340, w: 1200, h: 200 },     // Replay proof: old_status 500 -> new_status 200
  "term.chaos": { x: 24, y: 340, w: 1200, h: 200 },      // the 429 chaos rule request for POST /api/v1/webhooks/stripe
  "studio.waterfall": { x: 228, y: 280, w: 580, h: 420 },// the HTTP Flight Recorder Waterfall panel
  "studio.trace_row": { x: 240, y: 300, w: 560, h: 72 }, // the top trace row
  "studio.drift_finding": { x: 240, y: 298, w: 580, h: 84 }, // GET /api/v1/orders/102 with the "2 drifts" chip
  "studio.replay_banner": { x: 288, y: 210, w: 1280, h: 120 }, // "Deterministic Replay Verified: 500 -> 200" banner
  "studio.chaos_rules": { x: 228, y: 280, w: 580, h: 240 },
};

export const R = (key: keyof typeof GUESS): Rect => {
  const [clip] = key.split(".");
  return rectOf(clip, key, GUESS[key]);
};
