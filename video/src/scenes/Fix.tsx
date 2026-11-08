import React from "react";
import { interpolate, interpolateColors } from "remotion";
import { C, display, mono } from "../theme";
import { clamp, expo } from "../ui/motion";
import { Footage, syncTo } from "../ui/Footage";
import { Words } from "../ui/Words";
import { Count } from "../ui/Count";
import { R } from "../rects";
import { COUPON_ROUTE, S } from "../data";
import { Card, Cut, Fill, Head, In, Kicker, Label, Mono, Pending, useCue } from "./common";

/** Paper: the patch, then the replay of the exact captured request. 500 becomes 200, measured. */
export const Fix: React.FC = () => {
  const { f, rel } = useCue("fix");
  const tPatch = rel("patches");
  const tThen = rel("Faultline") - 2; // "Faultline replays the exact captured request."
  const tReplays = rel("replays");
  const tFive = rel("Five");
  const tBecomes = rel("becomes");
  const tTwo = rel("two");
  const tNot = rel("Not");
  const tMeasure = rel("measurement.");
  const rp = S?.replay;
  const oldS = rp?.old_status ?? 500;
  const newS = rp?.new_status ?? 200;
  const roll = interpolate(f, [tBecomes, tTwo], [0, 1], { ...clamp, easing: expo });
  const figColor = interpolateColors(roll, [0, 1], [C.ember, "#1f9c6a"]);
  const arrow = interpolate(f, [tBecomes - 2, tBecomes + 10], [0, 1], { ...clamp, easing: expo });
  return (
    <Fill tone="paper">
      <div style={{ position: "absolute", left: 96, top: 78 }}>
        <In at={0}><Kicker tone="paper">real hermes chat session · the patch, then faultline_replay(trace_id)</Kicker></In>
      </div>
      <div style={{ position: "absolute", left: 96, top: 104 }}>
        <Head size={40}><Words text="Fix. Prove." at={rel("Hermes") - 2} every={6} /></Head>
      </div>

      {/* the terminal: the patch, then a cut to the replay */}
      <Cut from={0} until={tThen}>
        <Footage name="term" tag="hermes chat · the patch" tone="paper" left={96} top={160} width={900} height={620}
          startFrom={syncTo("term", "patch.applied", tPatch + 8)}
          cams={[{ f: 0, z: 1.1 }, { f: tPatch, z: 1.1 }, { f: tPatch + 16, rect: R("term.patch"), z: 1.5 }]} />
      </Cut>
      <Cut from={tThen}>
        <Footage name="term" tag="hermes chat · the replay" tone="paper" left={96} top={160} width={900} height={620}
          startFrom={syncTo("term", "replay.done", tTwo - tThen - 2)}
          cams={[{ f: 0, z: 1.1 }, { f: tReplays - tThen, z: 1.1 }, { f: tReplays - tThen + 16, rect: R("term.replay"), z: 1.6 }]} />
      </Cut>

      {/* the measurement */}
      <div style={{ position: "absolute", left: 1040, top: 160, width: 784 }}>
        <In at={tFive - 6}><Kicker tone="paper">faultline_replay · the exact captured request, re-sent</Kicker></In>
        <div style={{ display: "flex", alignItems: "baseline", gap: 22, marginTop: 20, fontFamily: display, fontWeight: 700, letterSpacing: "-0.04em", lineHeight: 1, fontSize: 172, fontVariantNumeric: "tabular-nums" }}>
          {/* the captured status, then the arrow, then the replayed status rolling in as it is measured */}
          <span style={{ color: C.ember, opacity: interpolate(f, [tFive - 2, tFive + 8], [0, 1], clamp), transform: `translateY(${(1 - interpolate(f, [tFive - 2, tFive + 14], [0, 1], { ...clamp, easing: expo })) * 30}px)`, display: "inline-block" }}>{oldS}</span>
          <svg width={120} height={60} viewBox="0 0 120 60" style={{ opacity: arrow, alignSelf: "center", flex: "none" }}>
            <path d="M4 30 H108 M84 8 L108 30 L84 52" fill="none" stroke={C.paperInk} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - arrow} />
          </svg>
          <span style={{ color: figColor, opacity: interpolate(f, [tBecomes, tBecomes + 6], [0, 1], clamp), display: "inline-block", transform: `translateY(${(1 - interpolate(f, [tBecomes, tBecomes + 14], [0, 1], { ...clamp, easing: expo })) * 24}px)` }}>
            <Count from={oldS} to={newS} at={tBecomes} dur={Math.max(8, tTwo - tBecomes)} />
          </span>
        </div>
        <div style={{ marginTop: 10, fontFamily: mono, fontSize: 17, color: C.paperMuted, opacity: interpolate(f, [tFive, tFive + 10], [0, 1], clamp) }}>{COUPON_ROUTE}{rp ? ` · ${rp.original_trace_id} replayed as ${rp.replay_trace_id}` : ""}</div>

        <div style={{ marginTop: 36, fontFamily: display, fontWeight: 500, fontSize: 64, lineHeight: 1.05, letterSpacing: "-0.02em" }}>
          <div style={{ color: C.paperMuted }}><Words text="Not a claim." at={tNot - 2} every={4} /></div>
          <div style={{ color: C.paperInk }}><Words text="A measurement." at={rel("A", 1) - 2} every={4} accent="measurement." /></div>
        </div>
      </div>

      {/* the replay record */}
      <Card at={tMeasure - 2} left={96} top={800} width={1728} height={140} tone="paper" accent="#1f9c6a">
        {rp ? (
          <div style={{ display: "flex", gap: 56, alignItems: "flex-start" }}>
            <Fact k="status_transition" v={rp.status_transition} tone="paper" strong />
            <Fact k="resolved_error" v={String(rp.resolved_error)} tone="paper" />
            <Fact k="latency" v={`${rp.old_latency_ms.toFixed(2)} ms → ${rp.new_latency_ms.toFixed(2)} ms`} tone="paper" />
            <Fact k="drifts_remaining" v={String(rp.drifts_remaining ?? 0)} tone="paper" />
            <Fact k="replay_id" v={rp.replay_id} tone="paper" />
          </div>
        ) : (
          <div>
            <Label tone="paper">faultline_replay result</Label>
            <Pending compact tone="paper" what="data/session.json · replay (status_transition, resolved_error, old/new latency_ms, replay_id)" style={{ marginTop: 10 }} />
          </div>
        )}
      </Card>
    </Fill>
  );
};

const Fact: React.FC<{ k: string; v: string; tone: "paper" | "dark"; strong?: boolean }> = ({ k, v, strong }) => (
  <div>
    <Label tone="paper">{k}</Label>
    <div style={{ marginTop: 8 }}><Mono size={strong ? 30 : 22} weight={strong ? 600 : 500} color={strong ? "#1f9c6a" : C.paperInk}>{v}</Mono></div>
  </div>
);
