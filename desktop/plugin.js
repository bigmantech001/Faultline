import {
  PALETTE_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  TRANSCRIPT_DIRECTIVE_AREA,
  host,
} from "@hermes/plugin-sdk";
import { useCallback, useEffect, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";

const PANES_AREA = "panes";
const TRACE_ID_RE = /^flt-[0-9a-f]{8}$/;

// Set in register(): ctx.rest is scoped to this plugin's backend namespace
// (/api/plugins/faultline), profile-aware, and works against remote backends.
let restClient = null;

async function api(path, opts) {
  if (!restClient) throw new Error("Faultline backend is not connected");
  return restClient(path, opts);
}

// The Electron bridge wraps rejections as "Error invoking remote method 'hermes:api': Error: <status>: <body>";
// show only the part after that prefix.
function errorText(err) {
  const msg = err && typeof err.message === "string" ? err.message : typeof err === "string" ? err : "";
  const raw = msg.trim() || "Unknown error";
  const m = raw.match(/Error invoking remote method '[^']+': (?:Error: )?([\s\S]+)$/);
  return (m ? m[1] : raw).trim();
}

function arrow(text) {
  return String(text || "").replace(/ -> /g, " → ");
}

function prettyBody(text) {
  if (text === null || text === undefined || text === "") return "(empty body)";
  const s = String(text);
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch (_err) {
    return s;
  }
}

function driftLabel(count) {
  return `${count} drift${count === 1 ? "" : "s"}`;
}

function notify(kind, message) {
  try {
    host.notify({ kind, message });
  } catch (_err) {
    // older hosts without notify: stay quiet
  }
}

function notifyFailure(summary, err) {
  try {
    if (typeof host.notifyError === "function") {
      host.notifyError(err, summary);
      return;
    }
  } catch (_err) {
    // fall through to the plain toast
  }
  notify("error", `${summary}: ${errorText(err)}`);
}

// Drift messages from the recorder quote fields and endpoints in backticks; render those as code.
function richText(text) {
  const parts = String(text || "").split("`");
  if (parts.length < 3 || parts.length % 2 === 0) return String(text || "");
  return parts.map((part, i) =>
    i % 2 === 1
      ? jsx("code", { style: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }, children: part }, String(i))
      : part
  );
}

function replayFailed(replay) {
  return !!replay && (replay.ok === false || Number(replay.new_status) >= 400);
}

function upstreamUnreachable(replay) {
  const body = replay && replay.replay_response_body;
  return typeof body === "string" && body.includes("upstream_unreachable");
}

function statusColor(status) {
  if (status >= 500) return "#ef4444";
  if (status >= 400) return "#f59e0b";
  if (status >= 200 && status < 300) return "#10b981";
  return "#60a5fa";
}

function FaultlineStudioView() {
  const [statusData, setStatusData] = useState(null);
  const [traces, setTraces] = useState([]);
  const [contractsData, setContractsData] = useState(null);
  const [chaosRules, setChaosRules] = useState([]);
  const [selectedTrace, setSelectedTrace] = useState(null);
  const [replayResult, setReplayResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [filterMode, setFilterMode] = useState("all");
  const [loadError, setLoadError] = useState(null);

  const refreshAll = useCallback(async () => {
    const tracesPath =
      filterMode === "drifts"
        ? "/traces?only_drifts=true&limit=40"
        : `/traces?status_filter=${encodeURIComponent(filterMode)}&limit=40`;
    const calls = [
      ["status", api("/status"), (st) => setStatusData(st)],
      ["traces", api(tracesPath), (tr) => setTraces((tr && tr.traces) || [])],
      ["contracts", api("/contracts"), (ct) => setContractsData(ct)],
      ["chaos", api("/chaos"), (ch) => setChaosRules((ch && ch.rules) || [])],
    ];
    // Each section updates on its own; one failing endpoint must not blank the others.
    const results = await Promise.allSettled(calls.map((c) => c[1]));
    const failed = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") calls[i][2](r.value);
      else failed.push({ name: calls[i][0], reason: r.reason });
    });
    if (failed.length === 0) {
      setLoadError(null);
    } else if (failed.length === calls.length) {
      setLoadError(`Faultline backend unreachable: ${errorText(failed[0].reason)}`);
    } else {
      setLoadError(
        `Could not refresh ${failed.map((f) => f.name).join(", ")}: ${errorText(failed[0].reason)}`
      );
    }
  }, [filterMode]);

  useEffect(() => {
    refreshAll();
    const timer = setInterval(refreshAll, 4000);
    return () => clearInterval(timer);
  }, [refreshAll]);

  const runSimulation = async () => {
    setBusy(true);
    try {
      const sim = await api("/simulate", { method: "POST", body: { scenario: "checkout_pipeline" } });
      setReplayResult((sim && sim.replay_verification) || null);
      await refreshAll();
    } catch (err) {
      notifyFailure("Faultline simulation failed", err);
    } finally {
      setBusy(false);
    }
  };

  const triggerReplay = async (traceId) => {
    setBusy(true);
    try {
      const res = await api("/replay", { method: "POST", body: { trace_id: traceId } });
      if (res && res.ok === false) {
        setReplayResult(null);
        notify("error", `Faultline replay failed: ${res.error}`);
      } else {
        setReplayResult(res);
      }
      await refreshAll();
    } catch (err) {
      notifyFailure("Faultline replay failed", err);
    } finally {
      setBusy(false);
    }
  };

  const addQuickChaos = async (pathPattern, statusCode, latencyMs) => {
    try {
      await api("/chaos", {
        method: "POST",
        body: {
          path_pattern: pathPattern,
          method: "ANY",
          fault_type: latencyMs > 0 ? "latency_and_status" : "status_code",
          status_code: statusCode,
          latency_ms: latencyMs,
          probability: 1.0,
        },
      });
      notify("info", `Faultline chaos rule added: ${pathPattern} → HTTP ${statusCode}`);
    } catch (err) {
      notifyFailure("Could not add chaos rule", err);
    }
    await refreshAll();
  };

  const removeChaos = async (ruleId) => {
    try {
      await api(`/chaos/${encodeURIComponent(ruleId)}`, { method: "DELETE" });
    } catch (err) {
      notifyFailure("Could not remove chaos rule", err);
    }
    await refreshAll();
  };

  const summary = (statusData && statusData.summary) || {};

  return jsxs("div", {
    style: {
      padding: "24px",
      color: "#e2e8f0",
      fontFamily: "system-ui, -apple-system, sans-serif",
      display: "flex",
      flexDirection: "column",
      gap: "20px",
    },
    children: [
      jsxs("div", {
        style: {
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid rgba(148, 163, 184, 0.2)",
          paddingBottom: "16px",
        },
        children: [
          jsxs("div", {
            children: [
              jsx("h1", {
                style: { margin: 0, fontSize: "22px", fontWeight: 700 },
                children: "Faultline — API Flight Recorder & Chaos Replay Studio",
              }),
              jsx("p", {
                style: { margin: "4px 0 0 0", color: "#94a3b8", fontSize: "13px" },
                children:
                  "Zero-config loopback reverse proxy, live OpenAPI 3.1 contract drift auditor, and 1-click deterministic trace replay.",
              }),
            ],
          }),
          jsxs("div", {
            style: { display: "flex", gap: "10px" },
            children: [
              jsx("button", {
                onClick: runSimulation,
                disabled: busy,
                style: {
                  background: "linear-gradient(135deg, #2563eb, #7c3aed)",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "8px",
                  padding: "9px 16px",
                  fontWeight: 600,
                  cursor: busy ? "wait" : "pointer",
                },
                children: busy ? "Running Simulation..." : "Run Live Checkout Simulation",
              }),
              jsx("button", {
                onClick: () => addQuickChaos("/api/v1/webhooks", 429, 250),
                style: {
                  background: "rgba(245, 158, 11, 0.16)",
                  color: "#fbbf24",
                  border: "1px solid rgba(245, 158, 11, 0.4)",
                  borderRadius: "8px",
                  padding: "9px 14px",
                  fontWeight: 600,
                  cursor: "pointer",
                },
                children: "+ Inject 429 Chaos Rule",
              }),
            ],
          }),
        ],
      }),
      loadError
        ? jsx("div", {
            style: {
              background: "rgba(239, 68, 68, 0.12)",
              border: "1px solid rgba(239, 68, 68, 0.4)",
              borderRadius: "8px",
              padding: "10px 14px",
              fontSize: "12px",
              color: "#fca5a5",
            },
            children: `${loadError}. If this persists, check that the faultline plugin is enabled for this profile and restart the gateway.`,
          })
        : null,
      jsxs("div", {
        style: {
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: "12px",
        },
        children: [
          jsxs("div", {
            style: {
              background: "rgba(15, 23, 42, 0.7)",
              border: "1px solid rgba(148, 163, 184, 0.18)",
              borderRadius: "10px",
              padding: "14px",
            },
            children: [
              jsx("div", { style: { fontSize: "12px", color: "#94a3b8" }, children: "Captured Traces" }),
              jsx("div", {
                style: { fontSize: "24px", fontWeight: 700, marginTop: "4px" },
                children: String(summary.total_traces || 0),
              }),
            ],
          }),
          jsxs("div", {
            style: {
              background: "rgba(15, 23, 42, 0.7)",
              border: "1px solid rgba(239, 68, 68, 0.3)",
              borderRadius: "10px",
              padding: "14px",
            },
            children: [
              jsx("div", { style: { fontSize: "12px", color: "#fca5a5" }, children: "5xx Server Faults" }),
              jsx("div", {
                style: { fontSize: "24px", fontWeight: 700, color: "#ef4444", marginTop: "4px" },
                children: String(summary.count_5xx || 0),
              }),
            ],
          }),
          jsxs("div", {
            style: {
              background: "rgba(15, 23, 42, 0.7)",
              border: "1px solid rgba(245, 158, 11, 0.3)",
              borderRadius: "10px",
              padding: "14px",
            },
            children: [
              jsx("div", { style: { fontSize: "12px", color: "#fde68a" }, children: "OpenAPI Schema Drifts" }),
              jsx("div", {
                style: { fontSize: "24px", fontWeight: 700, color: "#f59e0b", marginTop: "4px" },
                children: String(summary.drift_traces || 0),
              }),
            ],
          }),
          jsxs("div", {
            style: {
              background: "rgba(15, 23, 42, 0.7)",
              border: "1px solid rgba(16, 185, 129, 0.3)",
              borderRadius: "10px",
              padding: "14px",
            },
            children: [
              jsx("div", { style: { fontSize: "12px", color: "#6ee7b7" }, children: "Learned OpenAPI Routes" }),
              jsx("div", {
                style: { fontSize: "24px", fontWeight: 700, color: "#10b981", marginTop: "4px" },
                children: String((contractsData && contractsData.contract_count) || 0),
              }),
            ],
          }),
        ],
      }),
      replayResult
        ? jsxs("div", {
            style: {
              background: replayFailed(replayResult) ? "rgba(239, 68, 68, 0.12)" : "rgba(16, 185, 129, 0.12)",
              border: replayFailed(replayResult)
                ? "1px solid rgba(239, 68, 68, 0.4)"
                : "1px solid rgba(16, 185, 129, 0.4)",
              borderRadius: "10px",
              padding: "14px 18px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "12px",
            },
            children: [
              jsxs("div", {
                children: [
                  jsxs("strong", {
                    style: { color: replayFailed(replayResult) ? "#fca5a5" : "#34d399" },
                    children: [
                      replayFailed(replayResult) ? "Replay failed: " : "Deterministic Replay Verified: ",
                      arrow(replayResult.status_transition) || replayResult.error || "",
                    ],
                  }),
                  jsxs("div", {
                    style: { fontSize: "12px", color: "#cbd5e1", marginTop: "4px" },
                    children: [
                      "Original Trace ",
                      replayResult.original_trace_id,
                      " → Replay Trace ",
                      replayResult.replay_trace_id,
                      " (",
                      String(replayResult.new_latency_ms),
                      " ms)",
                    ],
                  }),
                  upstreamUnreachable(replayResult)
                    ? jsx("div", {
                        style: { fontSize: "12px", color: "#fca5a5", marginTop: "4px" },
                        children:
                          "The upstream service did not answer. Start it (or pass a new target_url) and replay again.",
                      })
                    : null,
                ],
              }),
              jsx("span", {
                style: {
                  background: replayFailed(replayResult) ? "#ef4444" : "#10b981",
                  color: replayFailed(replayResult) ? "#450a0a" : "#052e16",
                  fontWeight: 700,
                  fontSize: "12px",
                  padding: "4px 10px",
                  borderRadius: "999px",
                  whiteSpace: "nowrap",
                },
                children: replayFailed(replayResult)
                  ? "REPLAY FAILED"
                  : replayResult.resolved_error
                    ? `BUG RESOLVED (${arrow(replayResult.status_transition)})`
                    : "REPLAY COMPLETE",
              }),
            ],
          })
        : null,
      jsxs("div", {
        style: { display: "flex", gap: "8px" },
        children: ["all", "5xx", "4xx", "drifts"].map((mode) =>
          jsx(
            "button",
            {
              onClick: () => setFilterMode(mode),
              style: {
                background: filterMode === mode ? "#3b82f6" : "rgba(30, 41, 59, 0.8)",
                color: "#f8fafc",
                border: "1px solid rgba(148, 163, 184, 0.25)",
                borderRadius: "6px",
                padding: "6px 12px",
                fontSize: "12px",
                cursor: "pointer",
              },
              children: mode.toUpperCase(),
            },
            mode
          )
        ),
      }),
      jsxs("div", {
        style: {
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.3fr) minmax(0, 1fr)",
          gap: "16px",
        },
        children: [
          jsxs("div", {
            style: {
              background: "rgba(15, 23, 42, 0.75)",
              border: "1px solid rgba(148, 163, 184, 0.18)",
              borderRadius: "10px",
              padding: "14px",
              minWidth: 0,
            },
            children: [
              jsx("h3", { style: { margin: "0 0 12px 0", fontSize: "15px" }, children: "HTTP Flight Recorder Waterfall" }),
              jsx("div", {
                style: { display: "flex", flexDirection: "column", gap: "8px" },
                children: traces.length === 0
                  ? jsx("p", {
                      style: { color: "#94a3b8", fontSize: "12px", margin: 0 },
                      children:
                        "No traces yet. Ask Hermes to start a Faultline proxy in front of your service, or run the live simulation.",
                    })
                  : traces.map((tr) =>
                  jsxs(
                    "div",
                    {
                      onClick: () => setSelectedTrace(tr),
                      style: {
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "10px 12px",
                        borderRadius: "8px",
                        cursor: "pointer",
                        background:
                          selectedTrace && selectedTrace.trace_id === tr.trace_id
                            ? "rgba(59, 130, 246, 0.2)"
                            : "rgba(30, 41, 59, 0.65)",
                        border: "1px solid rgba(148, 163, 184, 0.15)",
                      },
                      children: [
                        jsxs("div", {
                          style: { display: "flex", alignItems: "center", gap: "10px" },
                          children: [
                            jsx("span", {
                              style: {
                                color: statusColor(tr.response_status),
                                fontWeight: 700,
                                fontSize: "12px",
                                minWidth: "36px",
                              },
                              children: String(tr.response_status),
                            }),
                            jsx("span", {
                              style: { fontWeight: 600, fontSize: "12px", color: "#93c5fd" },
                              children: tr.method,
                            }),
                            jsx("code", {
                              style: { fontSize: "12px", color: "#e2e8f0" },
                              children: tr.path,
                            }),
                            tr.drifts && tr.drifts.length > 0
                              ? jsx("span", {
                                  style: {
                                    background: "rgba(245, 158, 11, 0.2)",
                                    color: "#fbbf24",
                                    fontSize: "11px",
                                    padding: "2px 6px",
                                    borderRadius: "4px",
                                  },
                                  children: driftLabel(tr.drifts.length),
                                })
                              : null,
                            tr.replayed_from
                              ? jsx("span", {
                                  title: `Replay of ${tr.replayed_from}`,
                                  style: {
                                    background: "rgba(59, 130, 246, 0.18)",
                                    color: "#93c5fd",
                                    fontSize: "11px",
                                    padding: "2px 6px",
                                    borderRadius: "4px",
                                  },
                                  children: "replay",
                                })
                              : null,
                            tr.chaos_rule_id
                              ? jsx("span", {
                                  title: `Injected by chaos rule ${tr.chaos_rule_id}`,
                                  style: {
                                    background: "rgba(148, 163, 184, 0.18)",
                                    color: "#cbd5e1",
                                    fontSize: "11px",
                                    padding: "2px 6px",
                                    borderRadius: "4px",
                                  },
                                  children: "chaos",
                                })
                              : null,
                          ],
                        }),
                        jsxs("div", {
                          style: { display: "flex", alignItems: "center", gap: "10px" },
                          children: [
                            jsx("span", {
                              style: { fontSize: "12px", color: "#94a3b8" },
                              children: `${tr.latency_ms} ms`,
                            }),
                            jsx("button", {
                              onClick: (e) => {
                                e.stopPropagation();
                                triggerReplay(tr.trace_id);
                              },
                              style: {
                                background: "rgba(59, 130, 246, 0.2)",
                                color: "#93c5fd",
                                border: "1px solid rgba(59, 130, 246, 0.4)",
                                borderRadius: "6px",
                                padding: "4px 8px",
                                fontSize: "11px",
                                cursor: "pointer",
                              },
                              children: "Replay",
                            }),
                          ],
                        }),
                      ],
                    },
                    tr.trace_id
                  )
                ),
              }),
            ],
          }),
          jsxs("div", {
            style: {
              background: "rgba(15, 23, 42, 0.75)",
              border: "1px solid rgba(148, 163, 184, 0.18)",
              borderRadius: "10px",
              padding: "14px",
              minWidth: 0,
            },
            children: [
              jsx("h3", {
                style: { margin: "0 0 12px 0", fontSize: "15px" },
                children: selectedTrace
                  ? `Trace Inspector (${selectedTrace.trace_id})`
                  : "Trace & Contract Drift Inspector",
              }),
              selectedTrace
                ? jsxs("div", {
                    style: { display: "flex", flexDirection: "column", gap: "10px", fontSize: "12px" },
                    children: [
                      jsxs("div", {
                        children: [
                          jsx("strong", { children: "Endpoint: " }),
                          jsx("code", { children: `${selectedTrace.method} ${selectedTrace.path}` }),
                        ],
                      }),
                      selectedTrace.drifts && selectedTrace.drifts.length > 0
                        ? jsxs("div", {
                            style: {
                              background: "rgba(245, 158, 11, 0.12)",
                              border: "1px solid rgba(245, 158, 11, 0.35)",
                              borderRadius: "8px",
                              padding: "10px",
                            },
                            children: [
                              jsx("strong", {
                                style: { color: "#fbbf24" },
                                children: "OpenAPI Contract Violations:",
                              }),
                              jsx("ul", {
                                style: { margin: "6px 0 0 0", paddingLeft: "18px" },
                                children: selectedTrace.drifts.map((d, idx) =>
                                  jsx("li", { children: richText(d.message) }, String(idx))
                                ),
                              }),
                            ],
                          })
                        : null,
                      jsx("div", { style: { color: "#94a3b8" }, children: "Redacted Request Payload:" }),
                      jsx("pre", {
                        style: {
                          background: "#020617",
                          padding: "10px",
                          borderRadius: "6px",
                          overflow: "auto",
                          maxHeight: "260px",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          margin: 0,
                        },
                        children: prettyBody(selectedTrace.request_body),
                      }),
                      jsx("div", { style: { color: "#94a3b8" }, children: "Response Payload:" }),
                      jsx("pre", {
                        style: {
                          background: "#020617",
                          padding: "10px",
                          borderRadius: "6px",
                          overflow: "auto",
                          maxHeight: "260px",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          margin: 0,
                        },
                        children: prettyBody(selectedTrace.response_body),
                      }),
                    ],
                  })
                : jsx("p", {
                    style: { color: "#94a3b8", fontSize: "13px" },
                    children:
                      "Select any captured HTTP trace on the left to inspect its redacted headers, JSON payload, OpenAPI schema drift report, or trigger a deterministic replay.",
                  }),
              chaosRules.length > 0
                ? jsxs("div", {
                    style: { marginTop: "16px", borderTop: "1px solid rgba(148,163,184,0.15)", paddingTop: "12px" },
                    children: [
                      jsx("h4", { style: { margin: "0 0 8px 0", fontSize: "13px" }, children: "Active Chaos Rules" }),
                      chaosRules.map((r) =>
                        jsxs(
                          "div",
                          {
                            style: {
                              fontSize: "12px",
                              color: "#fbbf24",
                              marginBottom: "4px",
                              display: "flex",
                              justifyContent: "space-between",
                              gap: "8px",
                            },
                            children: [
                              jsxs("span", {
                                children: [
                                  r.rule_id,
                                  ": ",
                                  r.method,
                                  " ",
                                  r.path_pattern,
                                  " → HTTP ",
                                  String(r.status_code),
                                  " (hits: ",
                                  String(r.hits),
                                  ")",
                                ],
                              }),
                              jsx("button", {
                                onClick: () => removeChaos(r.rule_id),
                                style: {
                                  background: "transparent",
                                  color: "#fca5a5",
                                  border: "1px solid rgba(239, 68, 68, 0.4)",
                                  borderRadius: "4px",
                                  fontSize: "11px",
                                  padding: "0 6px",
                                  cursor: "pointer",
                                },
                                children: "Remove",
                              }),
                            ],
                          },
                          r.rule_id
                        )
                      ),
                    ],
                  })
                : null,
            ],
          }),
        ],
      }),
    ],
  });
}

function FaultlineWaterfallPane() {
  const [traces, setTraces] = useState([]);
  // Panes stay mounted while hidden behind another tab; skip polling until this one is on screen.
  const [visible, setVisible] = useState(() => {
    try {
      if (typeof host.paneVisibility !== "function") return true;
      const atom = host.paneVisibility("faultline:waterfall");
      return !atom || typeof atom.get !== "function" ? true : atom.get() !== false;
    } catch (_err) {
      return true;
    }
  });

  useEffect(() => {
    if (typeof host.paneVisibility !== "function") return undefined;
    try {
      const atom = host.paneVisibility("faultline:waterfall");
      if (!atom || typeof atom.subscribe !== "function") return undefined;
      return atom.subscribe((value) => setVisible(value !== false));
    } catch (_err) {
      return undefined;
    }
  }, []);

  useEffect(() => {
    if (!visible) return undefined;
    let active = true;
    const load = async () => {
      try {
        const data = await api("/traces?limit=15");
        if (active) setTraces((data && data.traces) || []);
      } catch (_err) {
        // ignore
      }
    };
    load();
    const id = setInterval(load, 4000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [visible]);

  return jsxs("div", {
    style: { padding: "12px", color: "#e2e8f0", fontSize: "12px" },
    children: [
      jsx("div", {
        style: { fontWeight: 700, marginBottom: "10px", fontSize: "13px" },
        children: "Faultline Live Waterfall",
      }),
      traces.map((t) =>
        jsxs(
          "div",
          {
            style: {
              padding: "8px",
              marginBottom: "6px",
              borderRadius: "6px",
              background: "rgba(30, 41, 59, 0.7)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              gap: "8px",
            },
            children: [
              jsxs("span", {
                style: { minWidth: 0, overflowWrap: "anywhere" },
                children: [
                  jsx("strong", {
                    style: { color: statusColor(t.response_status), marginRight: "6px" },
                    children: String(t.response_status),
                  }),
                  t.method,
                  " ",
                  t.path,
                  t.replayed_from ? " · replay" : t.chaos_rule_id ? " · chaos" : "",
                  t.drifts && t.drifts.length > 0 ? ` · ${driftLabel(t.drifts.length)}` : "",
                ],
              }),
              jsxs("span", {
                style: { color: "#94a3b8", whiteSpace: "nowrap", flexShrink: 0 },
                children: [String(t.latency_ms), " ms"],
              }),
            ],
          },
          t.trace_id
        )
      ),
    ],
  });
}

function FaultlineStatusChip() {
  const [summary, setSummary] = useState({ total_traces: 0, count_5xx: 0, drift_traces: 0 });

  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      try {
        const data = await api("/status");
        if (mounted && data && data.summary) setSummary(data.summary);
      } catch (_e) {
        // ignore
      }
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  return jsxs("span", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: "6px",
      fontSize: "11px",
      padding: "2px 8px",
      borderRadius: "999px",
      background: summary.count_5xx > 0 ? "rgba(239, 68, 68, 0.2)" : "rgba(16, 185, 129, 0.16)",
      color: summary.count_5xx > 0 ? "#fca5a5" : "#6ee7b7",
    },
    children: [
      "Faultline: ",
      String(summary.total_traces || 0),
      " traces",
      summary.count_5xx > 0 ? ` · ${summary.count_5xx} server fault${summary.count_5xx === 1 ? "" : "s"}` : "",
    ],
  });
}

function FaultlineDirectiveCard({ traceId }) {
  const [trace, setTrace] = useState(null);
  const [missing, setMissing] = useState(false);
  const [replay, setReplay] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api(`/traces/${encodeURIComponent(traceId)}`)
      .then((d) => {
        if (!active) return;
        if (d && d.ok) setTrace(d);
        else setMissing(true);
      })
      .catch(() => active && setMissing(true));
    return () => {
      active = false;
    };
  }, [traceId]);

  const doReplay = async () => {
    setBusy(true);
    try {
      const res = await api("/replay", { method: "POST", body: { trace_id: traceId } });
      setReplay(res);
    } catch (err) {
      setReplay({ ok: false, error: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  if (missing) {
    return jsx("div", {
      style: { fontSize: "12px", color: "#94a3b8" },
      children: `Faultline trace ${traceId} is not in this profile's recorder.`,
    });
  }

  if (!trace) {
    return jsxs("div", {
      style: {
        padding: "10px 14px",
        borderRadius: "8px",
        border: "1px solid rgba(59, 130, 246, 0.35)",
        background: "rgba(15, 23, 42, 0.7)",
        color: "#e2e8f0",
        fontSize: "12px",
      },
      children: ["Faultline Trace Card: ", traceId || "loading..."],
    });
  }

  return jsxs("div", {
    style: {
      padding: "12px 14px",
      borderRadius: "10px",
      border: "1px solid rgba(59, 130, 246, 0.4)",
      background: "rgba(15, 23, 42, 0.85)",
      color: "#e2e8f0",
      fontSize: "12px",
    },
    children: [
      jsxs("div", {
        style: { display: "flex", justifyContent: "space-between", marginBottom: "6px" },
        children: [
          jsxs("strong", {
            children: [
              trace.method,
              " ",
              trace.path,
              " → HTTP ",
              String(trace.response_status),
            ],
          }),
          jsxs("span", { style: { color: "#94a3b8" }, children: [String(trace.latency_ms), " ms"] }),
        ],
      }),
      trace.drifts && trace.drifts.length > 0
        ? jsxs("div", {
            style: { color: "#fbbf24", marginBottom: "6px" },
            children: [
              jsx("div", {
                style: { fontWeight: 600 },
                children: trace.drifts.length === 1 ? "OpenAPI drift" : `OpenAPI drift (${trace.drifts.length} findings)`,
              }),
              jsx("ul", {
                style: { margin: "2px 0 0 0", paddingLeft: "16px" },
                children: trace.drifts.slice(0, 3).map((d, idx) =>
                  jsx("li", { children: richText(d.message) }, String(idx))
                ),
              }),
              trace.drifts.length > 3
                ? jsx("div", { style: { color: "#94a3b8" }, children: `+${trace.drifts.length - 3} more in the Studio` })
                : null,
            ],
          })
        : null,
      jsx("code", {
        style: {
          display: "block",
          whiteSpace: "pre-wrap",
          color: "#cbd5e1",
          maxHeight: "160px",
          overflowY: "auto",
        },
        children: prettyBody(trace.response_body),
      }),
      jsxs("div", {
        style: { display: "flex", alignItems: "center", gap: "10px", marginTop: "8px" },
        children: [
          jsx("button", {
            onClick: doReplay,
            disabled: busy,
            style: {
              background: "rgba(59, 130, 246, 0.2)",
              color: "#93c5fd",
              border: "1px solid rgba(59, 130, 246, 0.4)",
              borderRadius: "6px",
              padding: "4px 10px",
              fontSize: "11px",
              cursor: busy ? "wait" : "pointer",
            },
            children: busy ? "Replaying..." : "Replay",
          }),
          replay
            ? jsx("span", {
                style: { color: replayFailed(replay) ? "#fca5a5" : replay.resolved_error ? "#34d399" : "#cbd5e1" },
                children:
                  replay.ok === false
                    ? `Replay failed: ${replay.error}`
                    : `${arrow(replay.status_transition)} (${replay.new_latency_ms} ms)` +
                      (replay.resolved_error
                        ? " · resolved"
                        : replayFailed(replay)
                          ? upstreamUnreachable(replay)
                            ? " · failed (upstream unreachable)"
                            : " · failed"
                          : ""),
              })
            : null,
        ],
      }),
    ],
  });
}

export default {
  id: "faultline",
  name: "Faultline",
  register(ctx) {
    restClient = ctx.rest;
    ctx.onDispose(() => {
      restClient = null;
    });

    ctx.registerMany([
      {
        id: "studio",
        area: ROUTES_AREA,
        title: "Faultline Studio",
        data: { path: "/faultline" },
        render: () => jsx(FaultlineStudioView, {}),
      },
      {
        id: "nav",
        area: SIDEBAR_NAV_AREA,
        order: 42,
        data: { path: "/faultline", label: "Faultline", codicon: "pulse" },
      },
      {
        id: "waterfall",
        area: PANES_AREA,
        title: "Faultline",
        data: { placement: "right", width: "320px" },
        render: () => jsx(FaultlineWaterfallPane, {}),
      },
      {
        id: "status",
        area: STATUSBAR_AREAS.right,
        order: 125,
        render: () => jsx(FaultlineStatusChip, {}),
      },
      {
        id: "open",
        area: PALETTE_AREA,
        data: {
          id: "faultline.open",
          label: "Faultline: Open Studio",
          keywords: ["faultline", "api", "traces", "replay"],
          run: () => host.navigate("/faultline"),
        },
      },
      {
        id: "simulate",
        area: PALETTE_AREA,
        data: {
          id: "faultline.simulate",
          label: "Faultline: Run Live Capture & Replay Simulation",
          keywords: ["faultline", "simulate", "demo", "chaos"],
          run: async () => {
            try {
              const sim = await api("/simulate", { method: "POST", body: { scenario: "checkout_pipeline" } });
              const rpl = (sim && sim.replay_verification) || {};
              notify(
                replayFailed(rpl) ? "warning" : "success",
                `Faultline simulation: replay ${arrow(rpl.status_transition) || "done"}${replayFailed(rpl) ? " (replay failed)" : ""}`
              );
            } catch (err) {
              notifyFailure("Faultline simulation failed", err);
            }
          },
        },
      },
      {
        id: "trace-card",
        area: TRANSCRIPT_DIRECTIVE_AREA,
        data: {
          name: "faultline-trace",
          render: ({ attrs, source }) => {
            const traceId = attrs && typeof attrs.id === "string" ? attrs.id : "";
            if (!TRACE_ID_RE.test(traceId)) {
              // A claimed directive is lifted out of the paragraph, so show the model's text rather than nothing.
              return jsx("code", { style: { fontSize: "12px", color: "#94a3b8" }, children: source || "::faultline-trace" });
            }
            return jsx(FaultlineDirectiveCard, { traceId });
          },
        },
      },
    ]);
  },
};
