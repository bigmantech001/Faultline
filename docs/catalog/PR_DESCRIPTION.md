# PR description for the hermes-agent catalog submission

Title: `plugin-catalog: add faultline (local API flight recorder, contract drift and chaos replay)`

---

## Add `faultline`: local API flight recorder, contract drift detector and chaos replay

**What it does**

Faultline lets Hermes see real HTTP traffic while it debugs a service, instead of relying on pasted `curl` output.

- `faultline_proxy` starts a reverse proxy on `127.0.0.1` in front of the user's service and records every request and response to SQLite. Auth headers and secret JSON fields are redacted before anything is written.
- The first healthy `2xx` per route becomes a baseline schema. Later responses are flagged for `type_mismatch`, `missing_required_field`, `server_error_5xx` and `latency_regression`. `faultline_contract` exports the learned OpenAPI 3.1 document.
- `faultline_chaos` injects 429/5xx, latency or truncated JSON on matching routes.
- `faultline_replay` re-sends a captured failing request after the agent's fix and reports the status transition (`500 -> 200`), latency delta and remaining drift.
- `faultline_simulate` / `/faultline simulate` runs the whole loop against a built-in throwaway service, for a zero-setup demo.

**Hermes surfaces used**

- Tools: `faultline_proxy`, `faultline_traces`, `faultline_replay`, `faultline_contract`, `faultline_chaos`, `faultline_simulate`
- Middleware: `tool_execution` (times Faultline's own tools; other tools pass through)
- Hooks: `post_tool_call`, `on_session_start` (emit `plugin.faultline.*` events)
- Slash command `/faultline`, CLI `hermes faultline`, bundled skill `faultline:faultline-studio`
- Backend routes via `dashboard/plugin_api.py` (`/api/plugins/faultline/*`), shared by both UIs
- Web dashboard tab (`dashboard/dist/index.js`, SDK-only IIFE): stat tiles, filterable waterfall, trace inspector with drift findings, replay, chaos rules, learned contracts
- Desktop (`desktop/plugin.js`, SDK surface only, `ctx.rest` for all backend calls): `/faultline` page + sidebar entry, right pane, status-bar chip, two palette commands, `faultline-trace` transcript directive

**Disclosures (rule 13)**

- Network: the proxy listens on `127.0.0.1` only and forwards to the user-supplied `target_url`, normally a local service, but any `http(s)` host is accepted. No telemetry and no other outbound calls.
- Replay re-sends captured requests: replaying a `POST` repeats its side effects. The bundled skill tells the agent to confirm with the user before replaying non-idempotent calls. Redacted auth headers are not replayed.
- Data: traces (redacted), learned contracts, chaos rules and replay results are stored in SQLite under `$HERMES_HOME/plugin-data/faultline/`.
- Long-running processes: each proxy is a daemon HTTP server thread in the Hermes process, stopped with `faultline_proxy(action="stop")` or on exit.
- No credentials read, no shell commands, no subprocesses, no Python dependencies.

**Validation**

`hermes plugins validate` passes all checks at the pinned commit (security scan: safe, no core override, desktop surface OK). `python3 -m unittest discover -s tests` passes, covering registration, the middleware contract, redaction, drift detection, settings, header/redirect passthrough, concurrency, the simulate -> replay loop, the proxy registry, and the dashboard backend loaded exactly the way Hermes loads it.

**Screenshots**

Web dashboard tab, captured from a real `hermes dashboard`: `docs/screenshots/dashboard-replay.png`, `dashboard-inspector.png`, `dashboard-drift.png`.
<!-- Add Hermes Desktop captures (Faultline Studio page, right pane, ::faultline-trace card) before opening the PR. -->

**Demo video**

<!-- Link to the X post with the demo film (under 90 s). -->
