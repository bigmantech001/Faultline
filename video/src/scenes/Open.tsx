import React from "react";
import { interpolate } from "remotion";
import { C, mono } from "../theme";
import { clamp } from "../ui/motion";
import { Words } from "../ui/Words";
import { COUPON_REQUEST, COUPON_ROUTE, S, pretty } from "../data";
import { Card, Fill, Head, In, Json, Kicker, Label, Mono, Pending, Status, useCue } from "./common";

/** Cold open: one coupon, one 500, and an agent that never saw the request. */
export const Open: React.FC = () => {
  const { f, rel } = useCue("open");
  const tOne = rel("One");
  const tFive = rel("five");
  const tNever = rel("never");
  const tPaste = rel("paste");
  const tGuess = rel("guess.");
  const unseen = interpolate(f, [tNever, tNever + 12], [1, 0.3], clamp);
  const failing = S?.failing;
  return (
    <Fill tone="dark">
      <div style={{ position: "absolute", left: 96, top: 84 }}>
        <In at={2}><Kicker>storefront · {COUPON_ROUTE} · coupon {COUPON_REQUEST.coupon}</Kicker></In>
      </div>
      <div style={{ position: "absolute", left: 96, top: 150, width: 1740 }}>
        <Head size={182}><Words text="One coupon." at={tOne - 4} every={5} /></Head>
        <Head size={182} style={{ marginTop: 4 }}><Words text="Five hundred." at={tFive - 2} every={5} accent="hundred." /></Head>
      </div>

      {/* the real request (demo/client.py) and the real response (data/session.json) */}
      <Card at={rel("dies") - 4} left={96} top={560} width={980} height={340} accent={C.ember} style={{ opacity: unseen }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {failing ? <Status code={failing.response_status} size={18} /> : <Status code={500} size={18} />}
          <Mono size={20} weight={600}>{COUPON_ROUTE}</Mono>
          {failing ? <Mono size={16} color={C.muted}>{failing.latency_ms.toFixed(2)} ms · {failing.trace_id}</Mono> : null}
        </div>
        <div style={{ display: "flex", gap: 28, marginTop: 16 }}>
          <div style={{ width: 330 }}>
            <Label>request body</Label>
            <Json text={JSON.stringify(COUPON_REQUEST, null, 2)} size={17} style={{ marginTop: 8 }} />
          </div>
          <div style={{ flex: 1 }}>
            <Label>response body</Label>
            {failing ? (
              <Json text={pretty(failing.response_body)} size={17} reveal={rel("dies") + 4} perLine={2} style={{ marginTop: 8 }} />
            ) : (
              <Pending what="data/session.json · failing.response_body (the real 500)" style={{ marginTop: 10 }} />
            )}
          </div>
        </div>
      </Card>
      <div style={{ position: "absolute", left: 96, top: 954, opacity: interpolate(f, [tNever + 2, tNever + 12], [0, 1], clamp), fontFamily: mono, fontSize: 14, letterSpacing: "0.12em", textTransform: "uppercase", color: C.ember }}>
        not visible to the agent
      </div>

      {/* what the agent gets instead */}
      <div style={{ position: "absolute", left: 1140, top: 572, width: 700 }}>
        <Head size={88} style={{ color: C.muted }}><Words text="The agent never saw it." at={rel("agent") - 2} every={4} /></Head>
        <Head size={88} style={{ marginTop: 26 }}>
          <Words text="Paste logs." at={tPaste - 2} every={4} style={{ color: C.ink }} />
          <Words text="Guess." at={tGuess - 2} every={4} accent="guess." accentColor={C.ember} style={{ color: C.ember }} />
        </Head>
      </div>
    </Fill>
  );
};
