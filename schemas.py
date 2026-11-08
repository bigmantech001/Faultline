"""LLM Tool Schemas for Faultline (Local API Flight Recorder, Contract Verifier & Chaos Studio)."""

from __future__ import annotations

FAULTLINE_PROXY = {
    "name": "faultline_proxy",
    "description": (
        "Start, stop, or check the status of Faultline's local loopback HTTP Flight Recorder proxy "
        "(127.0.0.1:<listen_port> -> upstream_url), or record a request/response trace directly into the flight recorder."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["status", "start", "stop", "record", "clear"],
                "description": (
                    "'start' launches a loopback reverse proxy to upstream_url; 'stop' stops a running proxy; "
                    "'status' lists active proxies and trace counts; 'record' logs a trace directly; "
                    "'clear' purges stored traces."
                ),
            },
            "upstream_url": {
                "type": "string",
                "description": "Target local upstream URL when action='start' (e.g., 'http://127.0.0.1:8000').",
            },
            "listen_port": {
                "type": "integer",
                "description": "Optional loopback port to bind on 127.0.0.1 (0 or omitted picks a free port).",
            },
            "trace": {
                "type": "object",
                "description": "When action='record', a dict with method, path, status_code, request_body, response_body, latency_ms.",
            },
        },
        "required": ["action"],
    },
}

FAULTLINE_TRACES = {
    "name": "faultline_traces",
    "description": (
        "Query captured HTTP/webhook request-response traces from the Faultline flight recorder. "
        "Filter by status class ('5xx', '4xx', '2xx'), path substring, minimum latency (ms), or contract drift violations."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "trace_id": {
                "type": "string",
                "description": "Optional specific trace_id to inspect in full detail (headers, bodies, schema diff, replay receipt).",
            },
            "status_filter": {
                "type": "string",
                "enum": ["all", "errors", "5xx", "4xx", "2xx", "drifted", "replayed"],
                "description": "Filter traces by status category or contract drift state (default: 'all').",
            },
            "path_contains": {
                "type": "string",
                "description": "Optional substring to match against the request path.",
            },
            "limit": {
                "type": "integer",
                "description": "Maximum number of traces to return (default: 25).",
            },
        },
    },
}

FAULTLINE_REPLAY = {
    "name": "faultline_replay",
    "description": (
        "Deterministically replay a previously captured HTTP request (by trace_id) against its upstream URL "
        "(or an override target_url) after patching backend code. Compares the original status code, latency, "
        "and JSON response body against the replayed response to prove a bug fix (e.g., 500 -> 200 OK) and "
        "returns an inline ::faultline-trace{id=\"...\"} directive."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "trace_id": {
                "type": "string",
                "description": "The captured trace_id to replay (e.g., 'flt-a1b2c3d4').",
            },
            "target_url": {
                "type": "string",
                "description": "Optional override base URL (e.g., 'http://127.0.0.1:8081') to replay the request against.",
            },
            "override_headers": {
                "type": "object",
                "description": "Optional header overrides for the replay request.",
            },
            "override_body": {
                "type": "string",
                "description": "Optional modified request body for the replay.",
            },
        },
        "required": ["trace_id"],
    },
}

FAULTLINE_CONTRACT = {
    "name": "faultline_contract",
    "description": (
        "Inspect or export the inferred OpenAPI 3.1 / JSON Schema contracts learned from captured traffic, "
        "and list all detected contract drift anomalies (type mismatches, missing required fields, 5xx regressions)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "endpoint": {
                "type": "string",
                "description": "Optional endpoint key (e.g., 'GET /api/v1/orders/{id}') to inspect.",
            },
            "export_openapi": {
                "type": "boolean",
                "description": "If true, generates a complete OpenAPI 3.1.0 specification document from observed traffic.",
            },
        },
    },
}

FAULTLINE_CHAOS = {
    "name": "faultline_chaos",
    "description": (
        "Configure programmable Chaos Engineering fault-injection rules on Faultline's proxy routes "
        "(latency spikes, HTTP 429 rate-limits, HTTP 503 service drops, or corrupted JSON responses) "
        "to verify how an application or agent handles upstream failures."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["list", "add", "remove", "clear", "toggle"],
                "description": "Action to perform on chaos rules.",
            },
            "rule_id": {
                "type": "string",
                "description": "Rule ID when action is 'remove' or 'toggle'.",
            },
            "path_prefix": {
                "type": "string",
                "description": "URL path prefix the fault rule targets (e.g., '/api/v1/checkout' or '/webhooks').",
            },
            "method": {
                "type": "string",
                "description": "HTTP method to match ('GET', 'POST', or '*' for any; default '*').",
            },
            "fault_type": {
                "type": "string",
                "enum": ["status_code", "latency", "corrupt_json", "latency_and_status"],
                "description": "Type of chaos fault to inject.",
            },
            "status_code": {
                "type": "integer",
                "description": "HTTP error status code to return when fault_type includes status_code (e.g., 429, 503, 502).",
            },
            "latency_ms": {
                "type": "integer",
                "description": "Artificial delay in milliseconds to inject (e.g., 800).",
            },
            "probability": {
                "type": "number",
                "description": "Probability between 0.0 and 1.0 that the fault triggers on a matching request (default: 1.0).",
            },
        },
        "required": ["action"],
    },
}

FAULTLINE_SIMULATE = {
    "name": "faultline_simulate",
    "description": (
        "Run a self-contained live Faultline sandbox simulation: spins up an ephemeral loopback microservice "
        "and Faultline proxy, captures baseline 200 OK traffic, records a 500 checkout division-by-zero crash, "
        "detects a JSON schema contract drift violation, triggers a 429 Chaos Rule, hot-patches the microservice, "
        "and deterministically replays the failing 500 request to prove 500 -> 200 OK."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "scenario": {
                "type": "string",
                "enum": ["checkout_pipeline", "webhook_chaos"],
                "description": "Simulation scenario to execute (default: 'checkout_pipeline').",
            },
        },
    },
}

ALL_SCHEMAS = [
    FAULTLINE_PROXY,
    FAULTLINE_TRACES,
    FAULTLINE_REPLAY,
    FAULTLINE_CONTRACT,
    FAULTLINE_CHAOS,
    FAULTLINE_SIMULATE,
]

FAULTLINE_PROXY_SCHEMA = FAULTLINE_PROXY
FAULTLINE_TRACES_SCHEMA = FAULTLINE_TRACES
FAULTLINE_REPLAY_SCHEMA = FAULTLINE_REPLAY
FAULTLINE_CONTRACT_SCHEMA = FAULTLINE_CONTRACT
FAULTLINE_CHAOS_SCHEMA = FAULTLINE_CHAOS
FAULTLINE_SIMULATE_SCHEMA = FAULTLINE_SIMULATE

