import React from "react";
import { interpolate } from "remotion";
import { C } from "../theme";
import { clamp } from "../ui/motion";
import { Footage, Rect, markOf } from "../ui/Footage";
import { Words } from "../ui/Words";
import { BUMP } from "../beats";
import { S, WEBHOOK_ROUTE, pretty } from "../data";
import { Card, Chip, Fill, Head, In, Json, Kicker, Label, Mono, Pending, Status, useCue } from "./common";

// Measured on the held frame, page CSS px (1600x900).
const T_VERIFIED: Rect = { x: 0, y: 14, w: 1200, h: 190 }; // "Verified firing:" and its four result lines
const T_429: Rect = { x: 44, y: 44, w: 1250, h: 52 };       // POST /api/v1/webhooks/stripe -> 429 {"error":"faultline_chaos_injected","rule_id":"chaos-688910",...}
const T_UNTOUCHED: Rect = { x: 44, y: 100, w: 760, h: 82 }; // checkout and orders -> 200 (untouched), GET stripe -> 404 (method-scoped)
const T_WHY: Rect = { x: 0, y: 210, w: 1200, h: 230 };     // "the rule is POST-only ... deterministic retry testing" and the retry-path note

/** Chaos: a rule that answers the webhook with 429, and the amber row it leaves in the recorder. */
export const Chaos: React.FC = () => {
  const { s, f, rel } = useCue("chaos");
  const tRules = rel("rules");
  const tInject = rel("inject");
  const tBump = BUMP - s.from;
  const tLatency = rel("latency");
  const tSo = rel("You"); // "You learn how clients cope before production teaches you."
  const rule = S?.chaos?.rule;
  const trace = S?.chaos?.trace;
  return (
    <Fill tone="dark">
      <div style={{ position: "absolute", left: 96, top: 78 }}>
        <In at={0}><Kicker>real hermes chat session · faultline_chaos(action="add")</Kicker></In>
      </div>
      <div style={{ position: "absolute", left: 96, top: 104 }}>
        <Head size={40}><Words text="Break it on purpose." at={rel("Chaos") - 2} every={4} /></Head>
      </div>

      {/* The agent's own check of the rule: the webhook gets 429, every other route is untouched, GET is not caught. */}
      <Footage name="term" tag="hermes chat" left={96} top={160} width={992} height={620}
        hold={markOf("term", "chaos.verified", 2972)}
        cams={[
          { f: 0, z: 1.1 },
          { f: tInject - 4, z: 1.1 },
          { f: tInject + 14, rect: T_VERIFIED, z: 1.33 },
          { f: tSo - 6, rect: T_VERIFIED, z: 1.33 },
          { f: tSo + 14, rect: T_WHY, z: 1.33 },
        ]}
        marks={[
          { rect: T_429, at: tBump - 2, color: C.amber },
          { rect: T_UNTOUCHED, at: tLatency, color: C.moss },
        ]} />

      {/* the rule */}
      <Card at={tRules} left={1112} top={160} width={712} height={236} accent={C.amber}>
        <Label>chaos rule {rule ? `· ${rule.rule_id}` : ""}</Label>
        <div style={{ marginTop: 14 }}><Mono size={24} weight={600}>{rule ? `${rule.method} ${rule.path_pattern}` : WEBHOOK_ROUTE}</Mono></div>
        <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
          <Chip color={C.amber} solid>{rule ? `→ ${rule.status_code}` : "→ 429"}</Chip>
          <Chip color={C.muted}>{rule ? rule.fault_type : "status_code"}</Chip>
          <Chip color={C.muted}>{rule ? `probability ${rule.probability}` : "probability"}</Chip>
          <Chip color={C.muted}>{rule ? `hits ${rule.hits ?? 0}` : "hits"}</Chip>
        </div>
        {!rule ? <Pending compact what="data/session.json · chaos.rule" style={{ marginTop: 14 }} /> : (
          <div style={{ marginTop: 16 }}><Mono size={14} color={C.muted}>applies to every running proxy until removed</Mono></div>
        )}
      </Card>

      {/* the amber row */}
      <Card at={tBump} left={1112} top={416} width={712} height={230} accent={C.amber}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Status code={trace?.response_status ?? 429} size={17} />
          <Mono size={20} weight={600}>{trace ? `${trace.method} ${trace.path}` : WEBHOOK_ROUTE}</Mono>
          {trace ? <Mono size={15} color={C.muted}>{trace.latency_ms.toFixed(2)} ms</Mono> : null}
        </div>
        {trace ? (
          <Json text={pretty(trace.response_body)} size={16} reveal={tBump + 4} perLine={2} maxLines={6} style={{ marginTop: 12 }} />
        ) : (
          <Pending compact what="data/session.json · chaos.trace (the 429 the webhook received)" style={{ marginTop: 14 }} />
        )}
      </Card>

      {/* the other faults */}
      <Card at={tLatency - 2} left={1112} top={666} width={712} height={114} accent={null}>
        <Label>also on demand</Label>
        <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
          <Chip color={C.amber}>429 / 5xx status</Chip>
          <Chip color={C.sky}>latency_ms</Chip>
          <Chip color={C.ember}>truncated JSON</Chip>
        </div>
      </Card>

      <div style={{ position: "absolute", left: 96, top: 812, width: 1728, opacity: interpolate(f, [tSo - 2, tSo + 6], [0, 1], clamp) }}>
        <div style={{ fontFamily: "inherit", fontWeight: 500, fontSize: 56, lineHeight: 1.05, letterSpacing: "-0.02em", color: C.ink }}>
          <Words text="Learn how clients cope" at={tSo} every={3} />
          <Words text="before production teaches you." at={rel("before") - 2} every={3} accent="production" style={{ color: C.muted }} />
        </div>
      </div>
    </Fill>
  );
};
