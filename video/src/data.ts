import raw from "../data/session.json";

/**
 * The real session, exported from the plugin's recorder database into data/session.json
 * (scripts/session.mjs). Until that file holds a session, S is null and every scene shows a
 * clearly labelled "awaiting session" card instead of inventing numbers.
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
}

const r = raw as unknown as Partial<Session> & { pending?: boolean };
export const S: Session | null = r.pending || !r.failing || !r.replay ? null : (r as Session);

/** The storefront request that fails: demo/client.py, step "coupon". Fixed in the script, not measured. */
export const COUPON_REQUEST = { subtotal_cents: 5000, coupon: "FOUNDERS100" };
export const COUPON_ROUTE = "POST /api/v1/checkout";
export const DRIFT_ROUTE = "GET /api/v1/orders/102";
export const WEBHOOK_ROUTE = "POST /api/v1/webhooks/stripe";

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
