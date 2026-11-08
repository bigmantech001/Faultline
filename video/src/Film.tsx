import React from "react";
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from "remotion";
import { T, scene } from "./timing";
import { cue, BLIPS, BUMP, CRACK, RESOLVE, SPIKE } from "./beats";
import { C } from "./theme";
import { Ticker } from "./ui/Captions";
import { Grain } from "./ui/Grain";
import { FaultLine } from "./ui/FaultLine";
import { MaybeAudio } from "./ui/useExists";
import { clamp } from "./ui/motion";
import { Open } from "./scenes/Open";
import { Turn } from "./scenes/Turn";
import { Record } from "./scenes/Record";
import { See } from "./scenes/See";
import { Fix } from "./scenes/Fix";
import { Chaos } from "./scenes/Chaos";
import { Close } from "./scenes/Close";

export interface FilmProps { repo?: string; event?: string }

const WIPE = 6; // frames of the needle wipe
/** Scenes that come in on a needle wipe; the others are hard cuts (open -> turn is carried by the crack). */
const WIPES: Record<string, boolean> = { open: false, turn: false, record: true, see: true, fix: true, chaos: true, close: true };

/** The needle wipe: a thin orange line sweeps left to right over 6 frames with the new scene behind it. */
const SceneShell: React.FC<{ wipe: boolean; children: React.ReactNode }> = ({ wipe, children }) => {
  const f = useCurrentFrame();
  if (!wipe || f >= WIPE) return <AbsoluteFill>{children}</AbsoluteFill>;
  const p = interpolate(f, [0, WIPE], [0, 1], clamp);
  const x = p * 1920;
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ clipPath: `inset(0 ${(1 - p) * 100}% 0 0)` }}>{children}</AbsoluteFill>
      <div style={{ position: "absolute", top: 0, bottom: 0, left: x - 2, width: 4, background: C.orange, boxShadow: `0 0 18px ${C.orange}` }} />
    </AbsoluteFill>
  );
};

// Music, ducked under every spoken line.
const LINES = T.scenes.flatMap((s) => s.lines.map((l) => [l.startFrame, l.words[l.words.length - 1].end] as const));
const DUCK: number[] = (() => {
  const v = new Array<number>(T.totalFrames + 1).fill(0);
  for (let f = 0; f <= T.totalFrames; f++) {
    let d = 0;
    for (const [a, b] of LINES) d = Math.max(d, interpolate(f, [a - 10, a, b, b + 14], [0, 1, 1, 0], clamp));
    v[f] = d;
  }
  return v;
})();
const musicVolume = (f: number) => {
  const end = T.totalFrames;
  const fadeIn = interpolate(f, [0, 15], [0, 1], clamp);
  const fadeOut = interpolate(f, [end - 45, end], [1, 0], clamp);
  return (0.6 - 0.38 * DUCK[Math.min(end, Math.max(0, f))]) * fadeIn * fadeOut;
};

interface Fx { file: string; at: number; vol: number; dur?: number }
/** Word-synced effects (public/audio/sfx/<name>.mp3; a missing file is silently skipped). */
function effects(): Fx[] {
  const sc = (id: string) => scene(id).from;
  const w = (id: string, word: string, n = 0) => cue(id, word, n);
  const needleAt = T.scenes.filter((s) => WIPES[s.id]).map((s) => ({ file: "needle", at: s.from, vol: 0.32 }));
  const fx: Fx[] = [
    { file: "tick", at: 4, vol: 0.25 },
    { file: "static-blip", at: w("open", "dies") - 2, vol: 0.35 },
    { file: "thud-soft", at: SPIKE - 1, vol: 0.45 },
    { file: "static-blip", at: w("open", "never"), vol: 0.22 },
    ...[0, 5, 10].map((d) => ({ file: "key-click", at: w("open", "paste") + d, vol: 0.25 })),
    { file: "riser", at: sc("turn") - 48, vol: 0.3 },
    { file: "crack", at: CRACK - 1, vol: 0.6 },
    { file: "tick", at: w("turn", "A"), vol: 0.2 },
    ...needleAt,
    ...[0, 4, 8, 12].map((d) => ({ file: "key-click", at: w("record", "puts") + d, vol: 0.2 })),
    { file: "whoosh-soft", at: w("record", "proxy") - 2, vol: 0.25 },
    ...BLIPS.map((b) => ({ file: "data-blip", at: b, vol: 0.3 })),
    { file: "redact", at: w("record", "redacted") - 2, vol: 0.45 },
    { file: "whoosh-soft", at: w("see", "failing") - 2, vol: 0.25 },
    { file: "static-blip", at: w("see", "division") - 1, vol: 0.3 },
    { file: "data-blip", at: w("see", "two"), vol: 0.25 },
    { file: "whoosh-soft", at: w("see", "drift.") - 2, vol: 0.25 },
    { file: "lock", at: w("see", "string.") + 2, vol: 0.3 },
    { file: "lock", at: w("see", "missing.") + 2, vol: 0.3 },
    { file: "paper", at: sc("fix") + 2, vol: 0.3 },
    ...[0, 3, 6, 9, 12].map((d) => ({ file: "key-click", at: w("fix", "patches") + d, vol: 0.2 })),
    { file: "rewind", at: w("fix", "replays") - 4, vol: 0.35 },
    { file: "thud-soft", at: w("fix", "Five") - 1, vol: 0.3 },
    { file: "chime-resolve", at: RESOLVE - 1, vol: 0.45 },
    { file: "stamp", at: w("fix", "measurement.") - 2, vol: 0.5 },
    { file: "alarm-soft", at: BUMP, vol: 0.35 },
    { file: "data-blip", at: w("chaos", "latency"), vol: 0.25 },
    { file: "crack", at: w("close", "Faultline.") - 1, vol: 0.4 },
    { file: "lock", at: w("close", "Prove") + 2, vol: 0.35 },
    { file: "chime-resolve", at: w("close", "it.", 1) + 4, vol: 0.3 },
  ];
  return fx.filter((x) => x.at >= 0 && x.at < T.totalFrames);
}

export const Film: React.FC<FilmProps> = ({ repo, event }) => {
  const SCENES: Record<string, React.ReactNode> = {
    open: <Open />, turn: <Turn />, record: <Record />, see: <See />, fix: <Fix />, chaos: <Chaos />, close: <Close repo={repo} event={event} />,
  };
  // The ticker sits out where big type already carries the words.
  const hideTicker = (f: number) => {
    const s = T.scenes.find((x) => f >= x.from && f < x.from + x.durationInFrames);
    if (!s || ["open", "turn", "close"].includes(s.id)) return true;
    if (s.id === "fix" && f >= cue("fix", "Not") - 4) return true;      // "Not a claim. A measurement." is on screen
    if (s.id === "chaos" && f >= cue("chaos", "You") - 4) return true;  // "Learn how clients cope..." is on screen
    return false;
  };
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      {T.scenes.map((s, i) => {
        const body = SCENES[s.id];
        if (!body) return null;
        const next = T.scenes[i + 1];
        const extend = next && WIPES[next.id] ? WIPE : 0; // stay under the incoming scene while the needle sweeps
        return (
          <Sequence key={s.id} from={s.from} durationInFrames={s.durationInFrames + extend} name={s.id}>
            <SceneShell wipe={i > 0 && WIPES[s.id]}>{body}</SceneShell>
          </Sequence>
        );
      })}
      <FaultLine />
      <Grain opacity={0.05} />
      <Ticker hidden={hideTicker} bottom={92} />
      <MaybeAudio file="audio/music.mp3" volume={musicVolume} />
      {T.scenes.flatMap((s) => s.lines).map((l, i) => (
        <Sequence key={`vo${i}`} from={l.startFrame} durationInFrames={Math.max(1, l.durationFrames)} name={`vo ${l.text.slice(0, 18)}`}>
          <MaybeAudio file={l.file} volume={1} />
        </Sequence>
      ))}
      {effects().map((x, i) => (
        <Sequence key={`fx${i}`} from={x.at} durationInFrames={x.dur ?? 120} name={`fx ${x.file}`}>
          <MaybeAudio file={`audio/sfx/${x.file}.mp3`} volume={(f) => x.vol * (x.dur ? interpolate(f, [0, 8, x.dur - 20, x.dur], [0, 1, 1, 0], clamp) : 1)} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
