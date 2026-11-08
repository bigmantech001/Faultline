import React from "react";
import { interpolate } from "remotion";
import { C } from "../theme";
import { clamp } from "../ui/motion";
import { Footage, syncTo } from "../ui/Footage";
import { Words } from "../ui/Words";
import { R } from "../rects";
import { COUPON_ROUTE, DRIFT_ROUTE, S, pretty } from "../data";
import { Card, Cut, Fill, Head, In, Kicker, Label, Mono, Pending, Status, useCue } from "./common";

const errorOf = (body: string | undefined) => { try { return JSON.parse(body ?? "") as { error?: string; detail?: string }; } catch { return {}; } };

/** The failing call in the recorder, and drift on a route that still says 200. */
export const See: React.FC = () => {
  const { f, rel, dur } = useCue("see");
  const tFailing = rel("failing");
  const tDivision = rel("division");
  const tAnd = rel("On"); // "On a route that still returns two hundred..."
  const tTwo = rel("two");
  const tDrift = rel("drift.");
  const tTotal = rel("Total", 1);
  const tCurrency = rel("Currency");
  const failing = S?.failing;
  const drift = S?.drift;
  const err = errorOf(failing?.response_body);
  const typeDrift = drift?.drifts.find((d) => d.kind === "type_mismatch");
  const missing = drift?.drifts.find((d) => d.kind === "missing_required_field");
  return (
    <Fill tone="dark">
      <div style={{ position: "absolute", left: 96, top: 78 }}>
        <In at={0}><Kicker>real hermes chat session · faultline_traces(status_filter="5xx") · faultline_contract</Kicker></In>
      </div>
      <div style={{ position: "absolute", left: 96, top: 104 }}>
        <Head size={40}><Words text="See." at={rel("The") - 2} every={4} /></Head>
      </div>

      <Footage name="term" tag="hermes chat" left={96} top={160} width={992} height={620}
        startFrom={syncTo("term", "trace.read", tFailing - 4)}
        cams={[
          { f: 0, z: 1.1 },
          { f: tFailing - 6, z: 1.1 },
          { f: tFailing + 10, rect: R("term.trace"), z: 1.6 },
          { f: tAnd - 8, rect: R("term.trace"), z: 1.6 },
          { f: tAnd + 8, z: 1.1 },
        ]} />
      {/* the Studio: the trace row first, then a cut to the drift finding */}
      <Cut from={0} until={tAnd}>
        <Footage name="studio" tag="hermes desktop · faultline studio" left={1112} top={160} width={712} height={620}
          startFrom={syncTo("studio", "first_traces", 0)}
          cams={[{ f: 0, z: 1 }, { f: tFailing - 4, z: 1 }, { f: tFailing + 12, rect: R("studio.trace_row"), z: 1.8 }]} />
      </Cut>
      <Cut from={tAnd}>
        <Footage name="studio" tag="hermes desktop · faultline studio" left={1112} top={160} width={712} height={620}
          startFrom={syncTo("studio", "drift_visible", tDrift - tAnd)}
          cams={[{ f: 0, z: 1 }, { f: tDrift - tAnd - 4, z: 1 }, { f: tDrift - tAnd + 12, rect: R("studio.drift_finding"), z: 1.6 }]} />
      </Cut>

      {/* the failing call */}
      <Card at={tFailing} left={96} top={800} width={992} height={140} accent={C.ember} out={tAnd + 2}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Status code={failing?.response_status ?? 500} size={17} />
          <Mono size={20} weight={600}>{COUPON_ROUTE}</Mono>
          {failing ? <Mono size={15} color={C.muted}>{failing.trace_id} · {failing.latency_ms.toFixed(2)} ms</Mono> : null}
        </div>
        {failing ? (
          <div style={{ marginTop: 12, opacity: interpolate(f, [tDivision - 2, tDivision + 8], [0, 1], clamp) }}>
            <Mono size={22} weight={600} color={C.ember}>{err.error ?? "server_error_5xx"}</Mono>
            <div style={{ marginTop: 6 }}><Mono size={16} color={C.muted}>{err.detail ?? failing.drifts[0]?.message ?? ""}</Mono></div>
          </div>
        ) : (
          <Pending compact what="data/session.json · failing (trace_id, response_body, drifts)" style={{ marginTop: 12 }} />
        )}
      </Card>

      {/* drift on a 200 */}
      <Card at={tAnd + 6} left={96} top={800} width={1728} height={140} accent={C.amber} out={dur}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ opacity: interpolate(f, [tTwo - 2, tTwo + 6], [0, 1], clamp) }}><Status code={drift?.response_status ?? 200} size={17} /></span>
          <Mono size={20} weight={600}>{DRIFT_ROUTE}</Mono>
          <span style={{ opacity: interpolate(f, [tDrift - 2, tDrift + 6], [0, 1], clamp) }}><Label style={{ color: C.amber }}>openapi drift · {drift ? `${drift.drifts.length} findings` : "findings"}</Label></span>
          {drift ? <Mono size={15} color={C.muted}>{drift.trace_id}</Mono> : null}
        </div>
        {drift ? (
          <div style={{ display: "flex", gap: 40, marginTop: 14 }}>
            <div style={{ opacity: interpolate(f, [tTotal - 2, tTotal + 8], [0, 1], clamp) }}>
              <Mono size={14} color={C.muted}>type_mismatch</Mono>
              <div><Mono size={20} weight={600}>{typeDrift?.field ?? "$.total_cents"}</Mono> <Mono size={18} color={C.muted}>{String(typeDrift?.expected ?? "integer")} → </Mono><Mono size={18} color={C.amber}>{String(typeDrift?.actual ?? "string")}</Mono></div>
            </div>
            <div style={{ opacity: interpolate(f, [tCurrency - 2, tCurrency + 8], [0, 1], clamp) }}>
              <Mono size={14} color={C.muted}>missing_required_field</Mono>
              <div><Mono size={20} weight={600}>{missing?.field ?? "$.currency"}</Mono> <Mono size={18} color={C.amber}>{String(missing?.actual ?? "missing")}</Mono></div>
            </div>
            <div style={{ flex: 1, textAlign: "right", opacity: interpolate(f, [tTotal, tTotal + 10], [0, 1], clamp) }}>
              <Mono size={14} color={C.muted}>response body</Mono>
              <div><Mono size={15} color={C.muted}>{pretty(drift.response_body, 0).slice(0, 110)}</Mono></div>
            </div>
          </div>
        ) : (
          <Pending compact what="data/session.json · drift (GET /api/v1/orders/102 with type_mismatch and missing_required_field)" style={{ marginTop: 12 }} />
        )}
      </Card>
    </Fill>
  );
};
