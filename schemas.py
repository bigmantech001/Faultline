"""LLM tool schemas for Faultline (local API flight recorder, contract verifier and chaos studio).

This file is the contract between the model and ``tools.py``: every property declared here is read
by the matching handler, every enum value here is handled, and the handlers read nothing else except
the aliases named in the descriptions (``upstream_url`` for ``target_url``, ``path_prefix`` for
``path_pattern``). ``tests/test_faultline.py`` checks both directions.
"""

from __future__ import annotations

FAULTLINE_PROXY = {
    "name": "faultline_proxy",
    "description": (
        "Manage Faultline's local HTTP flight recorder proxy. 'start' binds a reverse proxy on "
        "127.0.0.1:<listen_port> that forwards to target_url, records every request and response "
        "(auth headers redacted), learns the route contracts and applies chaos rules; tell the user to "
        "point their client at the returned proxy_url, traffic that bypasses it is not recorded. "
        "'stop' stops one proxy (listen_port) or all of them. 'status' lists running proxies plus trace, "
        "contract and chaos rule counts. 'clear' deletes all recorded traces, learned contracts and replay "
        "receipts; chaos rules and running proxies are kept. This tool never records a trace by itself."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["status", "start", "stop", "clear"],
                "description": (
                    "'start' uses target_url and listen_port; 'stop' takes an optional listen_port "
                    "(omit it to stop every proxy); 'status' and 'clear' take no other parameters."
                ),
            },
            "target_url": {
                "type": "string",
                "description": (
                    "Base URL of the upstream service to put the proxy in front of, e.g. "
                    "'http://127.0.0.1:8000'. Used by action='start'; http(s) only; defaults to "
                    "http://127.0.0.1:8000 when omitted. The alias upstream_url is accepted too."
                ),
            },
            "listen_port": {
                "type": "integer",
                "description": (
                    "Loopback port for the proxy. With action='start', 0 or omitted picks a free port. "
                    "With action='stop', the port of the proxy to stop; omit to stop all."
                ),
            },
        },
        "required": ["action"],
    },
}

FAULTLINE_TRACES = {
    "name": "faultline_traces",
    "description": (
        "Read the traces Faultline's proxy recorded. Pass trace_id to get one trace in full (redacted "
        "headers, request and response bodies, inferred response schema, drift findings, chaos_rule_id, "
        "replayed_from). Otherwise list the newest traces, filtered by status class, contract drift, "
        "replay origin, path substring and HTTP method. Every trace carries a 'directive' string "
        "(::faultline-trace{id=\"flt-...\"}); embed it verbatim in the reply so Hermes Desktop renders "
        "the trace card with its Replay button."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "trace_id": {
                "type": "string",
                "description": "Exact trace id to fetch, e.g. 'flt-92e75bfe'. When set, every other parameter is ignored.",
            },
            "status_filter": {
                "type": "string",
                "enum": ["all", "errors", "5xx", "4xx", "2xx", "drifted", "replayed"],
                "description": (
                    "'all' (default) every trace; 'errors' status >= 400; '5xx', '4xx', '2xx' by status "
                    "class; 'drifted' only traces with contract drift findings, whatever their status; "
                    "'replayed' only traces produced by faultline_replay (replayed_from is set)."
                ),
            },
            "path_contains": {
                "type": "string",
                "description": "Substring the request path must contain, e.g. '/checkout'.",
            },
            "method": {
                "type": "string",
                "description": "HTTP method to match, e.g. 'POST'. Omit, '*' or 'ANY' for all methods.",
            },
            "limit": {
                "type": "integer",
                "description": "Maximum number of traces to return, newest first (default 25, max 200).",
            },
            "only_drifts": {
                "type": "boolean",
                "description": "true returns only traces with drift findings; the same as status_filter='drifted'. Default false.",
            },
        },
    },
}

FAULTLINE_REPLAY = {
    "name": "faultline_replay",
    "description": (
        "Re-send a recorded request (by trace_id) exactly as captured, against the upstream it was "
        "recorded from or an override target_url, and diff the result against the original: status "
        "transition (e.g. '500 -> 200'), latency delta, JSON keys, drifts remaining. Use it after a code "
        "fix to prove the fix. The replay is a real request with real side effects, so confirm with the "
        "user before replaying a non-idempotent call (checkout, payment, webhook). Redacted auth headers "
        "are not re-sent; pass fresh ones in override_headers. The replayed trace is recorded with "
        "replayed_from set and the result carries its ::faultline-trace directive."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "trace_id": {
                "type": "string",
                "description": "The recorded trace to replay, e.g. 'flt-92e75bfe'.",
            },
            "target_url": {
                "type": "string",
                "description": (
                    "Optional base URL to replay against instead of the trace's own upstream, e.g. "
                    "'http://127.0.0.1:8081' for a patched build on another port."
                ),
            },
            "override_headers": {
                "type": "object",
                "description": "Optional headers to add or replace on the replayed request, e.g. {\"Authorization\": \"Bearer ...\"}.",
            },
            "override_body": {
                "type": "string",
                "description": "Optional replacement request body (raw string) for the replay.",
            },
        },
        "required": ["trace_id"],
    },
}

FAULTLINE_CONTRACT = {
    "name": "faultline_contract",
    "description": (
        "Inspect the OpenAPI 3.1 contracts Faultline learned from recorded 2xx traffic and the drift "
        "findings against them. action='summary' (default) returns each learned contract (method, "
        "normalized path, expected status, request and response JSON schemas, baseline latency, sample "
        "count) plus the most recent drifted traces (type_mismatch, missing_required_field, "
        "server_error_5xx, latency_regression). action='openapi', or export_openapi=true, returns a "
        "complete OpenAPI 3.1.0 document built from those contracts instead. endpoint narrows both "
        "views to one route."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "endpoint": {
                "type": "string",
                "description": (
                    "Optional route filter, matched case-insensitively as a substring of "
                    "'METHOD /normalized/path' or of the raw path, e.g. 'GET /api/v1/orders/{id}' or "
                    "'/orders'. Filters the contracts, the drift list and the exported OpenAPI paths."
                ),
            },
            "export_openapi": {
                "type": "boolean",
                "description": "true returns the OpenAPI 3.1.0 document; the same as action='openapi'. Default false.",
            },
            "action": {
                "type": "string",
                "enum": ["summary", "openapi"],
                "description": "'summary' (default) lists contracts and recent drifts; 'openapi' returns the OpenAPI 3.1.0 document.",
            },
        },
    },
}

FAULTLINE_CHAOS = {
    "name": "faultline_chaos",
    "description": (
        "Manage the fault injection rules Faultline's proxy applies to matching requests. Rules persist "
        "until removed and apply to every running proxy. 'add' creates a rule, 'list' shows rules with "
        "hit counts, 'remove' deletes one by rule_id, 'clear' deletes all. fault_type 'status_code' "
        "answers with status_code and response_body without calling the upstream; 'latency' sleeps "
        "latency_ms and then forwards to the upstream normally; 'latency_and_status' sleeps and then "
        "answers with status_code; 'corrupt_json' answers with status_code and a truncated JSON body. "
        "Traces produced under a rule carry its rule_id in chaos_rule_id and an X-Faultline-Chaos header."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["list", "add", "remove", "clear"],
                "description": "'add' uses the rule parameters below; 'remove' needs rule_id; 'list' and 'clear' take nothing else.",
            },
            "rule_id": {
                "type": "string",
                "description": "Rule id for action='remove', e.g. 'chaos-688910' (from 'add' or 'list').",
            },
            "path_pattern": {
                "type": "string",
                "description": (
                    "Path to match for action='add': a substring of the request path (e.g. "
                    "'/api/v1/webhooks') or a regular expression; '/' or '*' matches every path. "
                    "Defaults to '/api/'. The alias path_prefix is accepted too."
                ),
            },
            "method": {
                "type": "string",
                "description": "HTTP method the rule matches, e.g. 'POST'. Omit, '*' or 'ANY' for any method.",
            },
            "fault_type": {
                "type": "string",
                "enum": ["status_code", "latency", "corrupt_json", "latency_and_status"],
                "description": (
                    "'status_code' (default): reply with status_code, no upstream call. 'latency': delay "
                    "latency_ms, then forward upstream. 'latency_and_status': delay, then reply with "
                    "status_code. 'corrupt_json': reply with status_code and a truncated JSON body."
                ),
            },
            "status_code": {
                "type": "integer",
                "description": "Status to inject for status_code, latency_and_status and corrupt_json rules, e.g. 429, 502, 503 (default 503).",
            },
            "latency_ms": {
                "type": "integer",
                "description": (
                    "Delay in milliseconds. Required and > 0 for latency and latency_and_status; capped at "
                    "3000 ms. If set on a status_code or corrupt_json rule the reply is delayed as well."
                ),
            },
            "probability": {
                "type": "number",
                "description": "Chance from 0.0 to 1.0 that a matching request gets the fault (default 1.0, every request).",
            },
            "response_body": {
                "type": "string",
                "description": (
                    "Optional body for status_code and latency_and_status replies, as a JSON string. "
                    "Default: a small JSON error naming the rule."
                ),
            },
        },
        "required": ["action"],
    },
}

FAULTLINE_SIMULATE = {
    "name": "faultline_simulate",
    "description": (
        "Run Faultline's self-contained demo, no user service needed: starts a throwaway checkout "
        "microservice and a Faultline proxy on loopback, records healthy traffic to learn two route "
        "contracts, records a 500 ZeroDivisionError on POST /api/v1/checkout, a schema drift on "
        "GET /api/v1/orders/102, and a 429 from a chaos rule on POST /api/v1/webhooks/stripe, then "
        "hot-patches the service and replays the failed trace to prove 500 -> 200. Records into the "
        "normal store, so the returned trace ids and directive resolve in Hermes Desktop."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "scenario": {
                "type": "string",
                "enum": ["checkout_pipeline"],
                "description": "Scenario to run. 'checkout_pipeline' is the only one available (default).",
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
