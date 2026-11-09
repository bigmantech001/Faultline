import React from "react";
import { interpolate } from "remotion";
import { C } from "../theme";
import { clamp } from "../ui/motion";
import { Footage, Rect, markOf, syncTo } from "../ui/Footage";
import { Words } from "../ui/Words";
import { R } from "../rects";
import { S, proxyPort } from "../data";
import { Card, Fill, Head, In, Kicker, Label, Mono, Pending, useCue } from "./common";

/** The Captured Traces / 5xx / Drifts tiles and the top of the waterfall, in the Studio's page CSS px. */
const LIVE: Rect = { x: 270, y: 140, w: 1000, h: 560 };
const TILES: Rect = { x: 284, y: 152, w: 966, h: 88 };

/** Split screen: the real hermes chat (left) starting the proxy, the real Studio (right) filling with traces. */
export const Record: React.FC = () => {
  const { f, rel } = useCue("record");
  const tProxy = rel("proxy");
  const tEvery = rel("Every");
  const tSecrets = rel("Secrets");
  const tRedacted = rel("redacted");
  const port = proxyPort();
  const auth = S?.failing?.request_headers?.Authorization ?? S?.failing?.request_headers?.authorization;
  const redactP = interpolate(f, [tRedacted - 2, tRedacted + 10], [0, 1], clamp);
  return (
    <Fill tone="dark">
      <div style={{ position: "absolute", left: 96, top: 78 }}>
        <In at={0}><Kicker>real hermes chat session · faultline_proxy(action="start", target_url="http://127.0.0.1:8000")</Kicker></In>
      </div>
      <div style={{ position: "absolute", left: 96, top: 104 }}>
        <Head size={40}><Words text="Record." at={rel("Hermes") - 2} every={4} /></Head>
      </div>

      <Footage name="term" tag="hermes chat" left={96} top={160} width={992} height={620} enter={0}
        startFrom={syncTo("term", "proxy.started", tProxy - 6)}
        cams={[
          { f: 0, z: 1 },
          { f: tProxy - 12, z: 1 },
          { f: tProxy + 6, rect: R("term.proxy_url"), z: 1.7 },
          { f: tEvery - 10, rect: R("term.proxy_url"), z: 1.7 },
          { f: tEvery + 10, z: 1.1 },
        ]} />
      {/* The Studio fills live while the storefront traffic lands: 7 -> 13 captured traces, the second 500 and the drifts, at 4x. */}
      <Footage name="studio" tag="hermes desktop · faultline studio" left={1112} top={160} width={712} height={620} enter={6}
        startFrom={markOf("studio", "traffic.baseline", 2525) - (tEvery - 28) * 4} rate={4}
        cams={[
          { f: 0, z: 1 },
          { f: tEvery - 34, z: 1 },
          { f: tEvery - 12, rect: LIVE, z: 1.5 },
        ]}
        marks={[{ rect: TILES, at: tEvery - 4, out: tSecrets + 10 }]} />

      {/* storefront -> proxy -> service */}
      <Card at={rel("service.") - 2} left={96} top={800} width={992} height={140} accent={C.orange}>
        <Label>the path of every request</Label>
        <div style={{ display: "flex", alignItems: "center", gap: 18, marginTop: 14, whiteSpace: "nowrap" }}>
          <Mono size={22} weight={600}>storefront</Mono>
          <Arrow />
          <Mono size={22} weight={600} color={C.orange}>{port ? `127.0.0.1:${port}` : "127.0.0.1:PORT"}</Mono>
          <Mono size={15} color={C.muted}>faultline proxy</Mono>
          <Arrow />
          <Mono size={22} weight={600}>127.0.0.1:8000</Mono>
          <Mono size={15} color={C.muted}>checkout service</Mono>
        </div>
        {!port ? <Pending compact what="data/session.json · proxy.proxy_url" style={{ marginTop: 10 }} /> : (
          <div style={{ marginTop: 12 }}><Mono size={15} color={C.muted}>recorded to SQLite in the Hermes home · every row on the right is a real request from this take</Mono></div>
        )}
      </Card>

      {/* redaction before write */}
      <Card at={tSecrets - 2} left={1112} top={800} width={712} height={140} accent={C.ember}>
        <Label>redacted before anything touches disk</Label>
        <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 12 }}>
          <Mono size={19} color={C.muted}>Authorization:</Mono>
          <span style={{ position: "relative", display: "inline-block" }}>
            <Mono size={19} color={C.faint} style={{ opacity: 1 - redactP }}>Bearer sk_live_…</Mono>
            <span style={{ position: "absolute", left: 0, top: "50%", height: 22, marginTop: -11, width: `${redactP * 100}%`, background: C.ember, opacity: 0.92 }} />
          </span>
          <Mono size={19} weight={600} color={C.ink} style={{ opacity: redactP }}>{auth ?? "[REDACTED]"}</Mono>
        </div>
        <div style={{ marginTop: 10 }}><Mono size={14} color={C.muted}>also Cookie, X-Api-Key and JSON fields password, api_key, access_token</Mono></div>
      </Card>
    </Fill>
  );
};

const Arrow: React.FC = () => (
  <svg width={46} height={14} viewBox="0 0 46 14"><path d="M0 7 H40 M34 1 L40 7 L34 13" fill="none" stroke={C.muted} strokeWidth={2} /></svg>
);
