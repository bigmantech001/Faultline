import {
  PALETTE_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  TRANSCRIPT_DIRECTIVE_AREA,
  usePluginCleanup,
} from "@hermes/plugin-sdk";
import { useCallback, useEffect, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";

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

  const refreshAll = useCallback(async () => {
    try {
      const [stRes, trRes, ctRes, chRes] = await Promise.all([
        fetch("/api/plugins/faultline/status"),
        fetch(
          filterMode === "drifts"
            ? "/api/plugins/faultline/traces?only_drifts=true&limit=40"
            : `/api/plugins/faultline/traces?status_filter=${encodeURIComponent(filterMode)}&limit=40`
        ),
        fetch("/api/plugins/faultline/contracts"),
        fetch("/api/plugins/faultline/chaos"),
      ]);
      if (stRes.ok) setStatusData(await stRes.json());
      if (trRes.ok) {
        const trJson = await trRes.json();
        setTraces(trJson.traces || []);
      }
      if (ctRes.ok) setContractsData(await ctRes.json());
      if (chRes.ok) {
        const chJson = await chRes.json();
        setChaosRules(chJson.rules || []);
      }
    } catch (_err) {
      // ignore offline preview state
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
      const res = await fetch("/api/plugins/faultline/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: "checkout_pipeline" }),
      });
      if (res.ok) {
        const sim = await res.json();
        setReplayResult(sim.replay_verification || null);
      }
      await refreshAll();
    } finally {
      setBusy(false);
    }
  };

  const triggerReplay = async (traceId) => {
    setBusy(true);
    try {
      const res = await fetch("/api/plugins/faultline/replay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trace_id: traceId }),
      });
      if (res.ok) {
        setReplayResult(await res.json());
      }
      await refreshAll();
    } finally {
      setBusy(false);
    }
  };

  const addQuickChaos = async (pathPattern, statusCode, latencyMs) => {
    await fetch("/api/plugins/faultline/chaos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path_pattern: pathPattern,
        method: "ANY",
        fault_type: latencyMs > 0 ? "latency_and_status" : "status_code",
        status_code: statusCode,
        latency_ms: latencyMs,
        probability: 1.0,
      }),
    });
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
              background: "rgba(16, 185, 129, 0.12)",
              border: "1px solid rgba(16, 185, 129, 0.4)",
              borderRadius: "10px",
              padding: "14px 18px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            },
            children: [
              jsxs("div", {
                children: [
                  jsxs("strong", {
                    style: { color: "#34d399" },
                    children: ["Deterministic Replay Verified: ", replayResult.status_transition],
                  }),
                  jsxs("div", {
                    style: { fontSize: "12px", color: "#cbd5e1", marginTop: "4px" },
                    children: [
                      "Original Trace ",
                      replayResult.original_trace_id,
                      " -> Replay Trace ",
                      replayResult.replay_trace_id,
                      " (",
                      String(replayResult.new_latency_ms),
                      " ms)",
                    ],
                  }),
                ],
              }),
              jsx("span", {
                style: {
                  background: "#10b981",
                  color: "#052e16",
                  fontWeight: 700,
                  fontSize: "12px",
                  padding: "4px 10px",
                  borderRadius: "999px",
                },
                children: replayResult.resolved_error ? "BUG RESOLVED (500 -> 200)" : "REPLAY COMPLETE",
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
          gridTemplateColumns: "1.3fr 1fr",
          gap: "16px",
        },
        children: [
          jsxs("div", {
            style: {
              background: "rgba(15, 23, 42, 0.75)",
              border: "1px solid rgba(148, 163, 184, 0.18)",
              borderRadius: "10px",
              padding: "14px",
            },
            children: [
              jsx("h3", { style: { margin: "0 0 12px 0", fontSize: "15px" }, children: "HTTP Flight Recorder Waterfall" }),
              jsx("div", {
                style: { display: "flex", flexDirection: "column", gap: "8px" },
                children: traces.map((tr) =>
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
                                  children: `${tr.drifts.length} drift`,
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
                                  jsx("li", { children: d.message }, String(idx))
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
                          overflowX: "auto",
                          margin: 0,
                        },
                        children: selectedTrace.request_body || "(empty body)",
                      }),
                      jsx("div", { style: { color: "#94a3b8" }, children: "Response Payload:" }),
                      jsx("pre", {
                        style: {
                          background: "#020617",
                          padding: "10px",
                          borderRadius: "6px",
                          overflowX: "auto",
                          margin: 0,
                        },
                        children: selectedTrace.response_body || "(empty body)",
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
                            style: { fontSize: "12px", color: "#fbbf24", marginBottom: "4px" },
                            children: [
                              r.rule_id,
                              ": ",
                              r.method,
                              " ",
                              r.path_pattern,
                              " -> HTTP ",
                              String(r.status_code),
                              " (hits: ",
                              String(r.hits),
                              ")",
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

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const res = await fetch("/api/plugins/faultline/traces?limit=15");
        if (res.ok && active) {
          const data = await res.json();
          setTraces(data.traces || []);
        }
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
  }, []);

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
            },
            children: [
              jsxs("span", {
                children: [
                  jsx("strong", {
                    style: { color: statusColor(t.response_status), marginRight: "6px" },
                    children: String(t.response_status),
                  }),
                  t.method,
                  " ",
                  t.path,
                ],
              }),
              jsxs("span", { style: { color: "#94a3b8" }, children: [String(t.latency_ms), "ms"] }),
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
        const res = await fetch("/api/plugins/faultline/status");
        if (res.ok && mounted) {
          const data = await res.json();
          if (data.summary) setSummary(data.summary);
        }
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
      summary.count_5xx > 0 ? ` (${summary.count_5xx} 5xx)` : "",
    ],
  });
}

function FaultlineDirectiveCard(props) {
  const attrs = (props && props.attributes) || {};
  const traceId = attrs.id || "";
  const [trace, setTrace] = useState(null);

  useEffect(() => {
    if (!traceId) return;
    fetch(`/api/plugins/faultline/traces/${encodeURIComponent(traceId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && d.ok) setTrace(d);
      })
      .catch(() => {});
  }, [traceId]);

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
              " -> HTTP ",
              String(trace.response_status),
            ],
          }),
          jsxs("span", { style: { color: "#94a3b8" }, children: [String(trace.latency_ms), " ms"] }),
        ],
      }),
      trace.drifts && trace.drifts.length > 0
        ? jsx("div", {
            style: { color: "#fbbf24", marginBottom: "6px" },
            children: `OpenAPI Drift: ${trace.drifts[0].message}`,
          })
        : null,
      jsx("code", {
        style: { display: "block", whiteSpace: "pre-wrap", color: "#cbd5e1" },
        children: trace.response_body || "",
      }),
    ],
  });
}

export default function registerFaultlineDesktopPlugin(registry) {
  usePluginCleanup(registry);

  registry.register(ROUTES_AREA, {
    id: "faultline-studio-route",
    path: "/faultline",
    title: "Faultline Studio",
    component: FaultlineStudioView,
  });

  registry.register(SIDEBAR_NAV_AREA, {
    id: "faultline-sidebar-item",
    label: "Faultline Studio",
    path: "/faultline",
    icon: "activity",
    order: 42,
  });

  if (registry.panes && typeof registry.panes.register === "function") {
    registry.panes.register({
      id: "faultline-waterfall-pane",
      title: "Faultline Waterfall",
      defaultDock: "right",
      component: FaultlineWaterfallPane,
    });
  }

  registry.register(STATUSBAR_AREAS.right, {
    id: "faultline-status-chip",
    component: FaultlineStatusChip,
    order: 25,
  });

  registry.register(PALETTE_AREA, {
    id: "faultline-palette-simulate",
    title: "Faultline: Run Live Capture & Replay Simulation",
    category: "Faultline",
    action: () => {
      fetch("/api/plugins/faultline/simulate", { method: "POST" }).catch(() => {});
    },
  });

  registry.register(TRANSCRIPT_DIRECTIVE_AREA, {
    id: "faultline-trace-directive",
    directive: "faultline-trace",
    component: FaultlineDirectiveCard,
  });
}
