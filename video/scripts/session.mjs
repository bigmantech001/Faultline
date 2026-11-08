// Exports the real session from Faultline's recorder database into data/session.json, the file the
// scenes read (src/data.ts). Read-only: the database is copied to a temp file first, so the live
// WAL is never touched.
//   DB=/path/to/faultline.db node scripts/session.mjs
//   HERMES_HOME=/path/to/home node scripts/session.mjs      (uses $HERMES_HOME/plugin-data/faultline/faultline.db)
// Shape written (see src/data.ts):
//   { generated_at, db, proxy: { proxy_url, target_url }, totals: { total_traces, server_errors, drift_traces, routes },
//     failing: <trace POST /api/v1/checkout 5xx>, drift: <trace GET /api/v1/orders/102 with drifts>,
//     chaos: { rule, trace: <the 429> }, replay: { replay_id, original_trace_id, replay_trace_id, old_status, new_status,
//              status_transition, resolved_error, old_latency_ms, new_latency_ms, drifts_remaining } }
// A trace carries trace_id, method, path, response_status, latency_ms, request_headers (as redacted), request_body,
// response_body, drifts[], created_at. Missing pieces are reported and left out; the scenes then show "awaiting session".
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const db = process.env.DB || (process.env.HERMES_HOME ? join(process.env.HERMES_HOME, "plugin-data/faultline/faultline.db") : null);
if (!db || !existsSync(db)) { console.error("set DB=<faultline.db> or HERMES_HOME=<home>; file not found: " + db); process.exit(2); }
const tmp = mkdtempSync(join(tmpdir(), "faultline-session-"));
copyFileSync(db, join(tmp, "copy.db"));
for (const side of ["-wal", "-shm"]) if (existsSync(db + side)) copyFileSync(db + side, join(tmp, "copy.db" + side));
const q = (sql) => { const out = execFileSync("sqlite3", ["-json", join(tmp, "copy.db"), sql]).toString().trim(); return out ? JSON.parse(out) : []; };

const trace = (row) => row && ({
  trace_id: row.trace_id, method: row.method, path: row.path, response_status: +row.response_status, latency_ms: +row.latency_ms,
  request_headers: JSON.parse(row.request_headers_json || "{}"), request_body: row.request_body, response_body: row.response_body,
  drifts: JSON.parse(row.drift_json || "[]"), created_at: row.created_at,
});
const one = (sql) => q(sql)[0];
const problems = [];

const failingRow = one(`SELECT * FROM traces WHERE method='POST' AND path='/api/v1/checkout' AND response_status>=500 AND replayed_from='' ORDER BY created_at ASC LIMIT 1`);
const driftRow = one(`SELECT * FROM traces WHERE method='GET' AND path LIKE '/api/v1/orders/%' AND response_status BETWEEN 200 AND 299 AND drift_json!='[]' ORDER BY created_at ASC LIMIT 1`);
const chaosTraceRow = one(`SELECT * FROM traces WHERE chaos_rule_id!='' ORDER BY created_at ASC LIMIT 1`);
const ruleRow = one(`SELECT * FROM chaos_rules ORDER BY created_at ASC LIMIT 1`);
const replayRow = failingRow ? one(`SELECT * FROM replays WHERE original_trace_id='${failingRow.trace_id}' ORDER BY created_at DESC LIMIT 1`) : null;
const proxyRow = one(`SELECT * FROM active_proxies ORDER BY started_at DESC LIMIT 1`);
const totals = one(`SELECT COUNT(*) AS total_traces, SUM(CASE WHEN response_status>=500 THEN 1 ELSE 0 END) AS server_errors, SUM(CASE WHEN drift_json!='[]' THEN 1 ELSE 0 END) AS drift_traces, (SELECT COUNT(*) FROM contracts) AS routes FROM traces`);

if (!failingRow) problems.push("no 5xx POST /api/v1/checkout trace");
if (!driftRow) problems.push("no drifting GET /api/v1/orders/{id} trace");
if (!ruleRow) problems.push("no chaos rule");
if (!chaosTraceRow) problems.push("no trace served by a chaos rule (the 429)");
if (!replayRow) problems.push("no replay of the failing trace");
if (!proxyRow) problems.push("no row in active_proxies (proxy_url unknown; pass PROXY_URL=...)");

const out = {
  generated_at: new Date().toISOString(),
  db,
  proxy: { proxy_url: process.env.PROXY_URL || (proxyRow ? `http://127.0.0.1:${proxyRow.listen_port}` : ""), target_url: proxyRow?.target_url || (failingRow?.target_url ?? "") },
  totals: { total_traces: +(totals?.total_traces ?? 0), server_errors: +(totals?.server_errors ?? 0), drift_traces: +(totals?.drift_traces ?? 0), routes: +(totals?.routes ?? 0) },
  ...(failingRow ? { failing: trace(failingRow) } : {}),
  ...(driftRow ? { drift: trace(driftRow) } : {}),
  ...(ruleRow || chaosTraceRow ? { chaos: { ...(ruleRow ? { rule: { rule_id: ruleRow.rule_id, method: ruleRow.method, path_pattern: ruleRow.path_pattern, fault_type: ruleRow.fault_type, status_code: +ruleRow.status_code, latency_ms: +ruleRow.latency_ms, probability: +ruleRow.probability, hits: +ruleRow.hits } } : {}), ...(chaosTraceRow ? { trace: trace(chaosTraceRow) } : {}) } } : {}),
  ...(replayRow ? { replay: {
    replay_id: replayRow.replay_id, original_trace_id: replayRow.original_trace_id, replay_trace_id: replayRow.replay_trace_id,
    old_status: +replayRow.old_status, new_status: +replayRow.new_status, status_transition: `${replayRow.old_status} -> ${replayRow.new_status}`,
    resolved_error: !!+replayRow.resolved_error, old_latency_ms: +replayRow.old_latency_ms, new_latency_ms: +replayRow.new_latency_ms,
    drifts_remaining: (JSON.parse(replayRow.diff_summary_json || "{}").drifts_remaining ?? 0),
  } } : {}),
  ...(problems.length ? { pending: !failingRow || !replayRow, problems } : {}),
};
mkdirSync(join(ROOT, "data"), { recursive: true });
writeFileSync(join(ROOT, "data/session.json"), JSON.stringify(out, null, 1));
console.log(`data/session.json: ${out.totals.total_traces} traces, ${out.totals.server_errors} 5xx, ${out.totals.drift_traces} drift, ${out.totals.routes} routes`);
if (failingRow) console.log(`failing ${failingRow.trace_id} ${failingRow.response_status} ${failingRow.latency_ms} ms`);
if (replayRow) console.log(`replay ${replayRow.replay_id}: ${out.replay.status_transition} resolved=${out.replay.resolved_error}`);
for (const p of problems) console.log("PROBLEM: " + p);
