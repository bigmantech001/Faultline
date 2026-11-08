---
name: faultline-studio
description: Local HTTP flight recorder, OpenAPI 3.1 contract drift verifier, chaos fault injector, and deterministic trace replay workflow for Hermes.
---

# Faultline API Flight Recorder & Replay Studio

Use the **Faultline** toolset whenever you are debugging local APIs, webhooks, microservices, full-stack endpoints, or HTTP regressions.

## Core Workflow

1. **Start or Inspect the Reverse Proxy (`faultline_proxy`)**
   - Call `faultline_proxy(action="start", listen_port=0, target_url="http://127.0.0.1:8000")` to spin up a loopback flight-recorder proxy in front of the user's local service.
   - Sensitive headers (`Authorization`, `Cookie`, `X-Api-Key`) and secret tokens in JSON payloads are automatically redacted before persistence.

2. **Inspect Captured Traces & Failures (`faultline_traces`)**
   - Call `faultline_traces(status_filter="5xx")` or `faultline_traces(only_drifts=True)` to inspect failing requests or schema drift violations without asking the user to copy-paste `curl` payloads.
   - Embed `::faultline-trace{id="flt-..."}` in your response so the user sees an interactive request/response and replay card in Hermes Desktop.

3. **Audit Learned OpenAPI 3.1 Contracts (`faultline_contract`)**
   - Faultline automatically learns baseline JSON schemas and latencies from healthy `2xx` responses and flags `type_mismatch`, `missing_required_field`, `server_error_5xx`, and `latency_regression` drifts.
   - Call `faultline_contract(action="openapi")` to export a complete OpenAPI 3.1 specification.

4. **Test Resilience with Chaos Rules (`faultline_chaos`)**
   - Inject synthetic `429`, `502`, `503`, artificial latency (`latency_ms`), or truncated JSON (`corrupt_json`) on specific routes using `faultline_chaos(action="add", path_pattern="/api/v1/webhooks", fault_type="status_code", status_code=429)`.

5. **Deterministically Verify Fixes (`faultline_replay`)**
   - After patching the backend code, call `faultline_replay(trace_id="flt-...")` to re-fire the exact captured request against the live service and prove `500 -> 200 OK` with latency and schema diffing.
