import raw from "../data/session.json";

/**
 * The real session, exported from the plugin's recorder database into data/session.json
 * (scripts/session_facts.py). That file is the recorder's own shape: proxy_url, failing_trace,
 * replays[], drift_traces[], orders_102[], chaos_rules[], traces[], contract_keys, recorded_utc,
 * hermes ... This module maps it onto the shape the scenes read (S below), with every value coming
 * straight from the file. Until the file holds a session, S is null and every scene shows a clearly
 * labelled "awaiting session" card instead of inventing numbers.
 */
export interface Drift { kind: string; field: string; expected: unknown; actual: unknown; severity: string; message: string }
export interface Trace {
  trace_id: string; method: string; path: string; response_status: number; latency_ms: number;
  request_headers?: Record<string, string>; request_body?: string; response_body: string; drifts: Drift[]; created_at?: string;
}
export interface ChaosRule { rule_id: string; method: string; path_pattern: string; fault_type: string; status_code: number; latency_ms: number; probability: number; hits?: number }
export interface Replay {
  replay_id: string; original_trace_id: string; replay_trace_id: string; old_status: number; new_status: number;
  status_transition: string; resolved_error: boolean; old_latency_ms: number; new_latency_ms: number; drifts_remaining?: number;
}
export interface Session {
  generated_at: string;
  proxy: { proxy_url: string; target_url: string };
  totals: { total_traces: number; server_errors: number; drift_traces: number; routes: number };
  failing: Trace;
  drift: Trace;
  chaos: { rule: ChaosRule; trace?: Trace };
  replay: Replay;
  hermes?: { version?: string; model?: string };
}

/** The recorder's export shape (only the parts this film quotes). */
interface RawTrace {
  trace_id: string; method: string; path: string; normalized_path?: string; target_url?: string; response_status: number; latency_ms: number;
  request_headers?: Record<string, string>; request_body?: string; response_body: string; drifts?: Drift[]; created_at?: string; chaos_rule_id?: string;
}
interface RawReplay {
  replay_id: string; original_trace_id: string; replay_trace_id: string; old_status: number; new_status: number;
  old_latency_ms: number; new_latency_ms: number; resolved_error: number | boolean;
  diff_summary?: { status_transition?: string; resolved_error?: boolean; drifts_remaining?: number };
}
interface RawSession {
  proxy_url?: string;
  failing_trace?: RawTrace;
  reproduced_by_agent_5xx?: RawTrace[];
  drift_traces?: RawTrace[];
  orders_102?: RawTrace[];
  replays?: RawReplay[];
  chaos_rules?: ChaosRule[];
  contract_keys?: string[];
  traces?: RawTrace[];
  cli?: { status?: { summary?: { total_traces?: number; count_5xx?: number; drift_traces?: number } } };
  recorded_utc?: { start?: string; end?: string };
  hermes?: { version?: string; model?: string };
}

const r = raw as unknown as RawSession;

const toTrace = (t: RawTrace | undefined): Trace | null =>
  t ? {
    trace_id: t.trace_id, method: t.method, path: t.path, response_status: t.response_status, latency_ms: t.latency_ms,
    request_headers: t.request_headers, request_body: t.request_body, response_body: t.response_body,
    drifts: t.drifts ?? [], created_at: t.created_at,
  } : null;

const toReplay = (p: RawReplay | undefined): Replay | null =>
  p ? {
    replay_id: p.replay_id, original_trace_id: p.original_trace_id, replay_trace_id: p.replay_trace_id,
    old_status: p.old_status, new_status: p.new_status, old_latency_ms: p.old_latency_ms, new_latency_ms: p.new_latency_ms,
    status_transition: p.diff_summary?.status_transition ?? `${p.old_status} → ${p.new_status}`,
    resolved_error: Boolean(p.diff_summary?.resolved_error ?? p.resolved_error),
    drifts_remaining: p.diff_summary?.drifts_remaining,
  } : null;

const buildSession = (): Session | null => {
  const failing = toTrace(r.failing_trace);
  const drift = toTrace(r.orders_102?.[0] ?? r.drift_traces?.find((t) => t.normalized_path === "/api/v1/orders/{id}"));
  const replay = toReplay(r.replays?.[0]);
  const rule = r.chaos_rules?.[0] ?? null;
  if (!r.proxy_url || !failing || !drift || !replay || !rule) return null;
  const chaosTrace = toTrace((r.traces ?? []).find((t) => t.response_status === rule.status_code && (t.chaos_rule_id ?? "") === rule.rule_id)) ?? undefined;
  const summary = r.cli?.status?.summary;
  return {
    generated_at: r.recorded_utc?.end ?? "",
    proxy: { proxy_url: r.proxy_url, target_url: r.failing_trace?.target_url ?? "http://127.0.0.1:8000" },
    totals: {
      total_traces: summary?.total_traces ?? (r.traces?.length ?? 0),
      server_errors: summary?.count_5xx ?? 0,
      drift_traces: summary?.drift_traces ?? (r.drift_traces?.length ?? 0),
      routes: r.contract_keys?.length ?? 0,
    },
    failing, drift, replay,
    chaos: { rule, trace: chaosTrace },
    hermes: r.hermes,
  };
};

export const S: Session | null = buildSession();

/** The storefront request that fails, read straight from the captured trace (demo/client.py "coupon"). */
const parseBody = (body: string | undefined): Record<string, unknown> | null => {
  if (!body) return null;
  try { return JSON.parse(body) as Record<string, unknown>; } catch { return null; }
};
export const COUPON_REQUEST = (parseBody(S?.failing?.request_body) as { subtotal_cents?: number; coupon?: string } | null) ?? { subtotal_cents: 5000, coupon: "FOUNDERS100" };
export const COUPON_ROUTE = S?.failing ? `${S.failing.method} ${S.failing.path}` : "POST /api/v1/checkout";
export const DRIFT_ROUTE = S?.drift ? `${S.drift.method} ${S.drift.path}` : "GET /api/v1/orders/102";
export const WEBHOOK_ROUTE = S?.chaos?.rule ? `${S.chaos.rule.method} ${S.chaos.rule.path_pattern}` : "POST /api/v1/webhooks/stripe";

/** The public repository, shown in the close scene. */
export const REPO = "github.com/bigmantech001/Faultline";

/** Pretty JSON for display; leaves non-JSON text alone. */
export const pretty = (body: string | undefined | null, indent = 2): string => {
  if (!body) return "";
  try { return JSON.stringify(JSON.parse(body), null, indent); } catch { return body; }
};

export const proxyPort = (): string | null => {
  const u = S?.proxy?.proxy_url;
  if (!u) return null;
  const m = u.match(/:(\d+)\/?$/);
  return m ? m[1] : null;
};
