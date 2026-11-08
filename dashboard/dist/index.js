/*
 * Faultline — Hermes web-dashboard tab. A plain IIFE loaded via <script> (no build
 * step): React, hooks, UI primitives and the authenticated JSON fetcher come from
 * window.__HERMES_PLUGIN_SDK__ (hermes-agent: web/src/plugins/registry.ts). The only
 * network traffic is SDK.fetchJSON(...) against /api/plugins/faultline/.
 */
(function () {
  "use strict";

  var SDK = window.__HERMES_PLUGIN_SDK__;
  var registry = window.__HERMES_PLUGINS__;
  if (!SDK || !SDK.React || !registry || typeof registry.register !== "function") {
    return; // not running inside the Hermes dashboard
  }

  var React = SDK.React;
  var h = React.createElement;
  var hooks = SDK.hooks || {};
  var useState = hooks.useState || React.useState;
  var useEffect = hooks.useEffect || React.useEffect;
  var useCallback = hooks.useCallback || React.useCallback;
  var useMemo = hooks.useMemo || React.useMemo;
  var useRef = hooks.useRef || React.useRef;
  var fetchJSON = SDK.fetchJSON;
  var utils = SDK.utils || {};

  // UI primitives from the SDK, with plain-element stand-ins so one missing
  // component can never take the whole tab down.
  var C = SDK.components || {};
  function fallback(tag) { return function (props) { return h(tag, props); }; }
  var Card = C.Card || fallback("div");
  var CardHeader = C.CardHeader || fallback("div");
  var CardTitle = C.CardTitle || fallback("h3");
  var CardContent = C.CardContent || fallback("div");
  var Badge = C.Badge || fallback("span");
  var Button = C.Button || fallback("button");
  var Separator = C.Separator || fallback("hr");
  var TabsList = C.TabsList || fallback("div");
  var TabsTrigger = C.TabsTrigger || fallback("button");

  // ── Constants ───────────────────────────────────────────────────────────

  var POLL_MS = 4000;
  var TRACE_LIMIT = 40;
  var FILTERS = [
    { id: "all", label: "All" },
    { id: "5xx", label: "5xx" },
    { id: "4xx", label: "4xx" },
    { id: "drifts", label: "Drifts" }
  ];
  // Same quick rule the Desktop half injects: every method on /api/v1/webhooks
  // answers 429 after a 250 ms delay until the rule is removed.
  var CHAOS_PRESET = {
    path_pattern: "/api/v1/webhooks",
    method: "ANY",
    fault_type: "latency_and_status",
    status_code: 429,
    latency_ms: 250,
    probability: 1.0
  };

  // Theme tokens. The dashboard defines --midground / --background-base at :root
  // and the shadcn-compat --color-* tokens in its Tailwind theme (web/src/index.css);
  // every var() carries a fallback tuned to the default dark (Hermes teal) theme.
  var T = {
    text: "var(--midground, #ffe6cb)",
    muted: "var(--color-text-secondary, rgba(255, 230, 203, 0.7))",
    border: "var(--color-border, rgba(255, 230, 203, 0.15))",
    muteBg: "var(--color-muted, rgba(255, 230, 203, 0.08))",
    accentBg: "var(--color-accent, rgba(255, 230, 203, 0.12))",
    destructive: "var(--color-destructive, #fb2c36)",
    success: "var(--color-success, #4ade80)",
    warning: "var(--color-warning, #ffbd38)",
    mono: "var(--theme-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)"
  };

  function tint(color) {
    return {
      background: "color-mix(in srgb, " + color + " 12%, transparent)",
      border: "1px solid color-mix(in srgb, " + color + " 35%, transparent)"
    };
  }
  function col(gap) {
    return { display: "flex", flexDirection: "column", gap: gap };
  }
  var ROW = { display: "flex", alignItems: "center", gap: 10, padding: "6px 0" };

  // ── API layer ───────────────────────────────────────────────────────────

  // Hermes mounts dashboard/plugin_api.py under /api/plugins/<name>; fetchJSON adds
  // the session token and the selected management profile.
  var API_BASE = "/api/plugins/faultline";

  function api(path, init) {
    if (typeof fetchJSON !== "function") {
      return Promise.reject(new Error("SDK.fetchJSON is unavailable in this dashboard build"));
    }
    return fetchJSON(API_BASE + path, init);
  }
  function postJSON(path, body) {
    return api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
  }
  function deleteJSON(path) {
    return api(path, { method: "DELETE" });
  }

  function describeError(err) {
    if (!err) return "Unknown error";
    var msg = typeof err === "string" ? err : (err.message || String(err));
    if (err.status === 404) {
      return msg + " — the Faultline backend routes are not mounted (HTTP 404 from " +
        (err.url || API_BASE) + "). Is the faultline plugin enabled for this profile? " +
        "Check the `hermes dashboard` log for \"Failed to load plugin faultline API routes\".";
    }
    return msg;
  }

  // ── Formatting helpers ──────────────────────────────────────────────────

  function list(x) {
    return Array.isArray(x) ? x : [];
  }
  function num(n) {
    var v = Number(n);
    return isFinite(v) ? v.toLocaleString() : "0";
  }
  function ms(n) {
    var v = Number(n);
    if (!isFinite(v)) return "–";
    return (v < 10 ? v.toFixed(2) : String(Math.round(v))) + " ms";
  }
  function arrowText(s) {
    return String(s || "").replace(/ -> /g, " → ");
  }
  // The host stylesheet paints bare <code> as a filled chip whose colour follows the text-selection
  // palette; our code runs transparent so it reads the same in every state.
  var CODE_STYLE = { background: "transparent", padding: 0, fontFamily: T.mono, color: T.text };
  function codeStyle(extra) {
    return Object.assign({}, CODE_STYLE, extra || {});
  }
  // Drift messages quote fields and endpoints in backticks; render those segments as code.
  function richNodes(text) {
    var parts = String(text || "").split("`");
    if (parts.length < 3 || parts.length % 2 === 0) return String(text || "");
    return parts.map(function (part, i) {
      return i % 2 === 1 ? h("code", { key: String(i), className: "text-xs", style: codeStyle() }, part) : part;
    });
  }
  function plural(count, word) {
    return num(count) + " " + word + (Number(count) === 1 ? "" : "s");
  }
  function statusTone(code) {
    var s = Number(code);
    if (s >= 500) return "destructive";
    if (s >= 400) return "warning";
    if (s >= 200 && s < 300) return "success";
    return "outline";
  }
  function prettyBody(text) {
    if (text === null || text === undefined || text === "") return "(empty body)";
    var s = String(text);
    try { return JSON.stringify(JSON.parse(s), null, 2); } catch (_e) { return s; }
  }
  function timeAgo(iso) {
    if (!iso) return "";
    try { return typeof utils.isoTimeAgo === "function" ? utils.isoTimeAgo(iso) : String(iso); } catch (_e) { return String(iso); }
  }
  function driftText(d) {
    if (!d) return "";
    if (typeof d === "string") return d;
    if (d.message) return String(d.message);
    try { return JSON.stringify(d); } catch (_e) { return String(d); }
  }

  // ── Small presentational pieces ─────────────────────────────────────────

  function Label(props) {
    return h("div", { className: "text-xs uppercase tracking-wide", style: { color: T.muted } }, props.children);
  }

  function Muted(props) {
    return h("p", { className: "text-sm", style: { color: T.muted, margin: 0 } }, props.children);
  }

  function Pre(props) {
    return h("pre", {
      className: "text-xs",
      style: {
        margin: 0, padding: 10, maxHeight: props.maxHeight || 240, overflow: "auto",
        whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: T.mono,
        background: T.muteBg, border: "1px solid " + T.border, borderRadius: 6, color: T.text
      }
    }, props.text);
  }

  function Tile(props) {
    var accent = props.tone === "destructive" ? T.destructive
      : props.tone === "warning" ? T.warning
      : props.tone === "success" ? T.success : null;
    return h(Card, { style: { minWidth: 0, borderLeft: accent ? "3px solid " + accent : undefined } },
      h(CardContent, { style: col(4) },
        h(Label, null, props.label),
        h("div", { className: "text-2xl font-semibold", style: { color: T.text, lineHeight: 1.1 } }, props.value)
      )
    );
  }

  function Banner(props) {
    var color = props.tone === "destructive" ? T.destructive
      : props.tone === "success" ? T.success
      : props.tone === "warning" ? T.warning : T.text;
    var style = Object.assign({
      display: "flex", alignItems: "flex-start", justifyContent: "space-between",
      gap: 12, padding: "10px 14px", borderRadius: 6, color: T.text
    }, tint(color));
    return h("div", { role: props.tone === "destructive" ? "alert" : "status", className: "text-sm", style: style },
      h("div", { style: { minWidth: 0, flex: 1, wordBreak: "break-word" } }, props.children),
      props.onDismiss
        ? h(Button, { ghost: true, size: "xs", "aria-label": "Dismiss", title: "Dismiss", onClick: props.onDismiss }, "×")
        : null
    );
  }

  function SectionHeader(props) {
    return h(CardHeader, {
      style: { display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }
    },
      h(CardTitle, null, props.title),
      props.right || null
    );
  }

  // ── Domain pieces ───────────────────────────────────────────────────────

  function TraceRow(props) {
    var tr = props.trace || {};
    var drifts = list(tr.drifts).length;
    var replaying = props.busy === "replay:" + tr.trace_id;
    function select() { props.onSelect(tr); }
    return h("div", {
      role: "button",
      tabIndex: 0,
      "aria-pressed": props.selected ? "true" : "false",
      onClick: select,
      onKeyDown: function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(); }
      },
      style: {
        display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 6,
        cursor: "pointer", minWidth: 0,
        border: "1px solid " + (props.selected ? T.text : T.border),
        background: props.selected ? T.accentBg : "transparent"
      }
    },
      h(Badge, { tone: statusTone(tr.response_status), className: "text-xs", style: { minWidth: 44, justifyContent: "center" } },
        tr.response_status == null ? "–" : String(tr.response_status)),
      h("span", { className: "text-xs font-semibold", style: { fontFamily: T.mono, minWidth: 48, color: T.text } }, tr.method || "–"),
      h("span", { className: "text-xs truncate", title: tr.path || "", style: { fontFamily: T.mono, flex: 1, minWidth: 0, color: T.text } },
        tr.path || "(no path)"),
      drifts > 0 ? h(Badge, { tone: "warning", className: "text-xs" }, plural(drifts, "drift")) : null,
      tr.chaos_rule_id ? h(Badge, { tone: "outline", className: "text-xs", title: "Injected by chaos rule " + tr.chaos_rule_id }, "chaos") : null,
      tr.replayed_from ? h(Badge, { tone: "secondary", className: "text-xs", title: "Replay of " + tr.replayed_from }, "replay") : null,
      h("span", { className: "text-xs", style: { color: T.muted, minWidth: 58, textAlign: "right", fontVariantNumeric: "tabular-nums" } },
        ms(tr.latency_ms)),
      h(Button, {
        size: "sm", outlined: true, disabled: !!props.busy || !tr.trace_id,
        title: "Re-fire this request against its upstream and diff the response",
        onClick: function (e) { e.stopPropagation(); props.onReplay(tr.trace_id); }
      }, replaying ? "Replaying…" : "Replay")
    );
  }

  function EmptyState(props) {
    if (props.filter !== "all") {
      return h(Muted, null, "No captured traces match this filter yet.");
    }
    return h("div", { className: "text-sm", style: { padding: 14, borderRadius: 6, border: "1px dashed " + T.border, color: T.text } },
      h("div", { className: "font-semibold" }, "No traces captured yet"),
      h("p", { className: "text-xs", style: { color: T.muted, margin: "6px 0 0" } },
        "Faultline records the traffic that flows through one of its loopback proxies. Start one in front of your service by asking Hermes to run"),
      h("code", { className: "text-xs", style: codeStyle({ display: "block", margin: "6px 0" }) },
        'faultline_proxy(action="start", target_url="http://127.0.0.1:8000")'),
      h("p", { className: "text-xs", style: { color: T.muted, margin: 0 } },
        "then point your client at the returned proxy_url (http://127.0.0.1:<port>). Requests appear here within " +
        (POLL_MS / 1000) + " seconds. No service handy? The live checkout simulation records a realistic 200 / 500 / drift / chaos sequence and replays the fix."),
      h("div", { style: { marginTop: 10 } },
        h(Button, { size: "sm", disabled: !!props.busy, onClick: props.onSimulate },
          props.busy === "simulate" ? "Running simulation…" : "Run live checkout simulation"))
    );
  }

  function Inspector(props) {
    var tr = props.trace;
    if (!tr) {
      return h(Muted, null,
        "Select a trace in the waterfall to inspect its contract-drift findings and redacted request / response bodies, or replay it against the upstream.");
    }
    var drifts = list(tr.drifts);
    return h("div", { style: col(10) },
      h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
        h(Badge, { tone: statusTone(tr.response_status), className: "text-xs" },
          tr.response_status == null ? "–" : String(tr.response_status)),
        h("code", { className: "text-sm", style: codeStyle({ wordBreak: "break-all" }) }, (tr.method || "") + " " + (tr.path || "")),
        h("span", { className: "text-xs", style: { color: T.muted } },
          ms(tr.latency_ms) + (tr.created_at ? " · " + timeAgo(tr.created_at) : ""))
      ),
      h("div", { className: "text-xs", style: { color: T.muted, fontFamily: T.mono, wordBreak: "break-all" } },
        (tr.trace_id || "") + (tr.target_url ? " → " + tr.target_url : "") +
        (tr.chaos_rule_id ? " · chaos " + tr.chaos_rule_id : "") +
        (tr.replayed_from ? " · replay of " + tr.replayed_from : "")),
      drifts.length > 0
        ? h("div", { style: Object.assign({ padding: 10, borderRadius: 6 }, tint(T.warning)) },
            h("div", { className: "text-xs font-semibold uppercase tracking-wide", style: { color: T.warning, marginBottom: 6 } },
              "OpenAPI contract drift · " + plural(drifts.length, "finding")),
            h("ul", { className: "text-sm", style: { margin: 0, paddingLeft: 18, color: T.text } },
              drifts.map(function (d, i) {
                return h("li", { key: i },
                  richNodes(driftText(d)),
                  d && d.severity ? h("span", { className: "text-xs", style: { color: T.muted } }, " (" + d.severity + ")") : null);
              })))
        : h("div", { className: "text-xs", style: { color: T.muted } }, "No contract drift against the learned baseline."),
      h(Separator, null),
      h(Label, null, "Redacted request body"),
      h(Pre, { text: prettyBody(tr.request_body) }),
      h(Label, null, "Response body"),
      h(Pre, { text: prettyBody(tr.response_body) })
    );
  }

  function ReplayBanner(props) {
    var r = props.replay || {};
    var resolved = !!r.resolved_error;
    var sim = props.simSummary;
    var cs = (sim && sim.contract_summary) || null;
    return h(Banner, { tone: resolved ? "success" : "secondary", onDismiss: props.onDismiss },
      h("div", { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
        h("strong", { className: "text-sm", style: { color: resolved ? T.success : T.text } },
          "Replay verified: " + arrowText(r.status_transition || "n/a")),
        h(Badge, { tone: resolved ? "success" : "secondary", className: "text-xs" }, resolved ? "Bug resolved" : "Replay complete"),
        r.new_latency_ms != null ? h("span", { className: "text-xs", style: { color: T.muted } }, "new latency " + ms(r.new_latency_ms)) : null
      ),
      h("div", { className: "text-xs", style: { color: T.muted, marginTop: 4, fontFamily: T.mono, wordBreak: "break-all" } },
        (r.original_trace_id || "?") + " → " + (r.replay_trace_id || "?")),
      cs
        ? h("div", { className: "text-xs", style: { color: T.muted, marginTop: 4 } },
            "Checkout simulation finished: " + plural(cs.learned_endpoints, "contract") + " learned, " +
            plural(cs.drift_traces_detected, "drift trace") + ", failing trace " + (sim.failed_trace_id || "?") + ".")
        : null
    );
  }

  function ChaosRule(props) {
    var r = props.rule || {};
    var hits = Number(r.hits) || 0;
    return h("div", { style: ROW },
      h("div", { style: { minWidth: 0, flex: 1 } },
        h("div", { className: "text-xs truncate", style: { fontFamily: T.mono, color: T.text } },
          (r.method || "ANY") + " " + (r.path_pattern || "") + " → HTTP " + (r.status_code == null ? "?" : r.status_code) +
          (Number(r.latency_ms) > 0 ? " +" + ms(r.latency_ms) : "")),
        h("div", { className: "text-xs", style: { color: T.muted } },
          (r.rule_id || "") + " · " + (r.fault_type || "status_code") + " · p=" + (r.probability == null ? "1" : r.probability))
      ),
      h(Badge, { tone: hits > 0 ? "warning" : "outline", className: "text-xs" }, plural(hits, "hit")),
      h(Button, {
        size: "sm", ghost: true, destructive: true, disabled: !!props.busy || !r.rule_id,
        onClick: function () { props.onRemove(r.rule_id); }
      }, props.busy === "remove:" + r.rule_id ? "Removing…" : "Remove")
    );
  }

  function ContractRow(props) {
    var c = props.contract || {};
    return h("div", { style: ROW },
      h(Badge, { tone: statusTone(c.expected_status), className: "text-xs" },
        c.expected_status == null ? "?" : String(c.expected_status)),
      h("code", { className: "text-xs truncate", title: c.contract_key || "", style: codeStyle({ flex: 1, minWidth: 0 }) },
        c.contract_key || ((c.method || "") + " " + (c.normalized_path || ""))),
      h("span", { className: "text-xs", style: { color: T.muted, whiteSpace: "nowrap" } },
        "baseline " + ms(c.baseline_latency_ms) + " · " + plural(c.sample_count, "sample"))
    );
  }

  // ── Page ────────────────────────────────────────────────────────────────

  function FaultlinePage() {
    var _status = useState(null), status = _status[0], setStatus = _status[1];
    var _traces = useState([]), traces = _traces[0], setTraces = _traces[1];
    var _contracts = useState(null), contracts = _contracts[0], setContracts = _contracts[1];
    var _chaos = useState([]), chaos = _chaos[0], setChaos = _chaos[1];
    var _filter = useState("all"), filter = _filter[0], setFilter = _filter[1];
    var _selected = useState(null), selected = _selected[0], setSelected = _selected[1];
    var _replay = useState(null), replay = _replay[0], setReplay = _replay[1];
    var _sim = useState(null), simSummary = _sim[0], setSimSummary = _sim[1];
    var _busy = useState(null), busy = _busy[0], setBusy = _busy[1]; // null | "simulate" | "chaos" | "replay:<id>" | "remove:<id>"
    var _loadError = useState(null), loadError = _loadError[0], setLoadError = _loadError[1];
    var _actionError = useState(null), actionError = _actionError[0], setActionError = _actionError[1];
    var _copy = useState(null), copyState = _copy[0], setCopyState = _copy[1]; // null | "copied" | "fallback"
    var _showSpec = useState(false), showSpec = _showSpec[0], setShowSpec = _showSpec[1];
    var _updated = useState(null), lastUpdated = _updated[0], setLastUpdated = _updated[1];
    var _tick = useState(0), tick = _tick[0], setTick = _tick[1];
    var copyTimer = useRef(null);

    // Bumping `tick` re-runs the polling effect: immediate fetch + fresh interval.
    var refresh = useCallback(function () {
      setTick(function (t) { return t + 1; });
    }, []);

    useEffect(function () {
      var cancelled = false;
      var tracesPath = filter === "drifts"
        ? "/traces?only_drifts=true&limit=" + TRACE_LIMIT
        : "/traces?limit=" + TRACE_LIMIT + "&status_filter=" + encodeURIComponent(filter);

      function load() {
        // Each section updates on its own; one failing endpoint must not blank the others.
        var calls = [
          ["status", api("/status"), function (v) { setStatus(v && typeof v === "object" ? v : null); }],
          ["traces", api(tracesPath), function (v) { setTraces(list(v && v.traces)); }],
          ["contracts", api("/contracts"), function (v) { setContracts(v && typeof v === "object" ? v : null); }],
          ["chaos", api("/chaos"), function (v) { setChaos(list(v && v.rules)); }]
        ];
        Promise.allSettled(calls.map(function (c) { return c[1]; })).then(function (results) {
          if (cancelled) return;
          var failed = [];
          results.forEach(function (r, i) {
            if (r.status === "fulfilled") calls[i][2](r.value);
            else failed.push({ name: calls[i][0], reason: r.reason });
          });
          if (failed.length === 0) {
            setLoadError(null);
            setLastUpdated(new Date());
          } else if (failed.length === calls.length) {
            setLoadError("Faultline backend unreachable: " + describeError(failed[0].reason));
          } else {
            setLastUpdated(new Date());
            setLoadError("Could not refresh " + failed.map(function (f) { return f.name; }).join(", ") +
              ": " + describeError(failed[0].reason));
          }
        });
      }

      load();
      var timer = setInterval(load, POLL_MS);
      return function () {
        cancelled = true;
        clearInterval(timer);
      };
    }, [filter, tick]);

    useEffect(function () {
      return function () {
        if (copyTimer.current) clearTimeout(copyTimer.current);
      };
    }, []);

    // Keep the inspector on the freshest copy of the selected trace.
    var selectedTrace = useMemo(function () {
      if (!selected) return null;
      for (var i = 0; i < traces.length; i++) {
        if (traces[i] && traces[i].trace_id === selected.trace_id) return traces[i];
      }
      return selected;
    }, [selected, traces]);

    var specText = useMemo(function () {
      if (!showSpec || !contracts || !contracts.openapi) return "";
      try { return JSON.stringify(contracts.openapi, null, 2); } catch (_e) { return String(contracts.openapi); }
    }, [contracts, showSpec]);

    function runAction(key, work) {
      setBusy(key);
      setActionError(null);
      return Promise.resolve()
        .then(work)
        .catch(function (err) { setActionError(describeError(err)); })
        .then(function () {
          setBusy(null);
          refresh();
        });
    }

    function runSimulation() {
      runAction("simulate", function () {
        return postJSON("/simulate", { scenario: "checkout_pipeline" }).then(function (sim) {
          if (!sim || sim.ok === false) throw new Error((sim && sim.error) || "Simulation failed");
          var rv = sim.replay_verification;
          setSimSummary(sim);
          if (rv && typeof rv === "object" && rv.ok !== false) {
            setReplay(rv);
          } else {
            setReplay(null);
            setActionError("Simulation ran, but its replay step failed: " + ((rv && rv.error) || "unknown error"));
          }
        });
      });
    }

    function replayTrace(traceId) {
      if (!traceId) return;
      runAction("replay:" + traceId, function () {
        return postJSON("/replay", { trace_id: traceId }).then(function (res) {
          if (!res || res.ok === false) throw new Error((res && res.error) || "Replay failed");
          setSimSummary(null);
          setReplay(res);
        });
      });
    }

    function injectChaos() {
      runAction("chaos", function () {
        return postJSON("/chaos", CHAOS_PRESET).then(function (res) {
          if (res && res.ok === false) throw new Error(res.error || "Could not add the chaos rule");
        });
      });
    }

    function removeChaos(ruleId) {
      if (!ruleId) return;
      runAction("remove:" + ruleId, function () {
        return deleteJSON("/chaos/" + encodeURIComponent(ruleId)).then(function (res) {
          if (res && res.ok === false) throw new Error(res.error || "Could not remove the chaos rule");
        });
      });
    }

    function copySpec() {
      var spec = contracts && contracts.openapi;
      if (!spec) return;
      var text;
      try { text = JSON.stringify(spec, null, 2); } catch (_e) { text = String(spec); }
      function done(state) {
        setCopyState(state);
        if (state === "fallback") setShowSpec(true);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(function () { setCopyState(null); }, 2500);
      }
      var clip = typeof navigator !== "undefined" ? navigator.clipboard : null;
      if (clip && typeof clip.writeText === "function") {
        clip.writeText(text).then(function () { done("copied"); }, function () { done("fallback"); });
      } else {
        done("fallback");
      }
    }

    var summary = (status && status.summary) || {};
    var proxies = list(status && status.active_proxies);
    var contractRows = list(contracts && contracts.contracts);
    var contractCount = contracts && typeof contracts.contract_count === "number"
      ? contracts.contract_count
      : (status && typeof status.contract_count === "number" ? status.contract_count : contractRows.length);
    var filterCounts = {
      all: summary.total_traces, "5xx": summary.count_5xx, "4xx": summary.count_4xx, drifts: summary.drift_traces
    };

    return h("div", { style: col(16) },
      // Header: title, proxy state, primary actions.
      h("div", { style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" } },
        h("div", { style: { minWidth: 0 } },
          h("h2", { className: "font-mondwest text-display text-base tracking-wider", style: { margin: 0, color: T.text } }, "Faultline"),
          h("p", { className: "text-xs", style: { margin: "4px 0 0", color: T.muted } },
            "HTTP flight recorder · OpenAPI 3.1 contract-drift auditor · deterministic chaos replay"),
          h("div", { style: { marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
            proxies.length || !Number(summary.total_traces)
              ? h(Badge, { tone: proxies.length ? "success" : "outline", className: "text-xs" },
                  proxies.length === 0 ? "no proxy running" : (proxies.length === 1 ? "1 proxy live" : proxies.length + " proxies live"))
              : null,
            proxies.map(function (p, i) {
              return h("code", { key: (p && p.proxy_url) || i, className: "text-xs", style: codeStyle({ color: T.muted }) },
                ((p && p.proxy_url) || "") + " → " + ((p && p.target_url) || ""));
            })
          )
        ),
        h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
          h(Button, { size: "sm", disabled: !!busy, onClick: runSimulation },
            busy === "simulate" ? "Running simulation…" : "Run live checkout simulation"),
          h(Button, { size: "sm", outlined: true, disabled: !!busy, onClick: injectChaos },
            busy === "chaos" ? "Adding rule…" : "+ Inject 429 on /api/v1/webhooks")
        )
      ),

      loadError ? h(Banner, { tone: "destructive" }, loadError) : null,
      actionError ? h(Banner, { tone: "destructive", onDismiss: function () { setActionError(null); } }, actionError) : null,

      // Stat tiles.
      h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 } },
        h(Tile, { label: "Captured traces", value: num(summary.total_traces) }),
        h(Tile, { label: "5xx faults", value: num(summary.count_5xx), tone: Number(summary.count_5xx) > 0 ? "destructive" : null }),
        h(Tile, { label: "Drift traces", value: num(summary.drift_traces), tone: Number(summary.drift_traces) > 0 ? "warning" : null }),
        h(Tile, { label: "Learned routes", value: num(contractCount), tone: Number(contractCount) > 0 ? "success" : null })
      ),

      replay ? h(ReplayBanner, { replay: replay, simSummary: simSummary, onDismiss: function () { setReplay(null); setSimSummary(null); } }) : null,

      // Main grid: waterfall on the left, inspector / chaos / contracts on the right.
      h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 16, alignItems: "start" } },
        h(Card, null,
          h(SectionHeader, {
            title: "Flight recorder waterfall",
            right: h(TabsList, { "aria-label": "Trace filter" },
              FILTERS.map(function (f) {
                var count = filterCounts[f.id];
                return h(TabsTrigger, {
                  key: f.id, value: f.id, active: filter === f.id,
                  onClick: function () { setFilter(f.id); }
                }, f.label + (count != null ? " " + num(count) : ""));
              }))
          }),
          h(CardContent, { style: col(6) },
            traces.length === 0
              ? h(EmptyState, { filter: filter, busy: busy, onSimulate: runSimulation })
              : traces.map(function (tr, i) {
                  return h(TraceRow, {
                    key: (tr && tr.trace_id) || i,
                    trace: tr,
                    selected: !!(selectedTrace && tr && selectedTrace.trace_id === tr.trace_id),
                    busy: busy,
                    onSelect: setSelected,
                    onReplay: replayTrace
                  });
                })
          )
        ),

        h("div", { style: col(16) },
          h(Card, null,
            h(SectionHeader, {
              title: selectedTrace ? "Trace inspector" : "Trace & drift inspector",
              right: selectedTrace
                ? h(Button, { size: "sm", ghost: true, onClick: function () { setSelected(null); } }, "Clear")
                : null
            }),
            h(CardContent, null, h(Inspector, { trace: selectedTrace }))
          ),

          h(Card, null,
            h(SectionHeader, {
              title: "Chaos rules",
              right: h(Badge, { tone: chaos.length ? "warning" : "outline", className: "text-xs" }, num(chaos.length) + " active")
            }),
            h(CardContent, { style: col(2) },
              chaos.length === 0
                ? h(Muted, null, "No active chaos rules. Rules apply to every running proxy; use “+ Inject 429 on /api/v1/webhooks” to add one.")
                : chaos.map(function (r, i) {
                    return h(ChaosRule, { key: (r && r.rule_id) || i, rule: r, busy: busy, onRemove: removeChaos });
                  })
            )
          ),

          h(Card, null,
            h(SectionHeader, {
              title: "Learned contracts",
              right: h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
                copyState
                  ? h("span", { className: "text-xs", style: { color: copyState === "copied" ? T.success : T.warning } },
                      copyState === "copied" ? "Copied to clipboard" : "Clipboard unavailable — JSON shown below")
                  : null,
                h(Button, { size: "sm", outlined: true, disabled: !contracts || !contracts.openapi, onClick: copySpec }, "Copy OpenAPI JSON"),
                showSpec ? h(Button, { size: "sm", ghost: true, onClick: function () { setShowSpec(false); } }, "Hide JSON") : null)
            }),
            h(CardContent, { style: col(6) },
              contractRows.length === 0
                ? h(Muted, null, "No contracts learned yet. Faultline records a baseline from the first healthy 2xx response per method + normalized path and reports drift against it.")
                : contractRows.map(function (c, i) {
                    return h(ContractRow, { key: (c && c.contract_key) || i, contract: c });
                  }),
              showSpec ? h(Pre, { text: specText || "{}", maxHeight: 480 }) : null
            )
          )
        )
      ),

      h("div", { className: "text-xs", style: { color: T.muted, display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" } },
        h("span", null, "Polling every " + (POLL_MS / 1000) + " s" +
          (lastUpdated ? " · updated " + lastUpdated.toLocaleTimeString() : (loadError ? " · waiting for the backend" : " · loading…"))),
        h("span", { style: { fontFamily: T.mono } }, "API " + API_BASE)
      )
    );
  }

  // Render-time errors stay inside the tab instead of blanking the dashboard.
  class TabBoundary extends React.Component {
    state = { error: null };
    static getDerivedStateFromError(error) {
      return { error: error || new Error("Unknown render error") };
    }
    render() {
      if (this.state.error) {
        return h(Banner, { tone: "destructive" }, "The Faultline tab failed to render: " + describeError(this.state.error));
      }
      return this.props.children;
    }
  }

  function FaultlineTab() {
    return h(TabBoundary, null, h(FaultlinePage, null));
  }

  registry.register("faultline", FaultlineTab);
})();
