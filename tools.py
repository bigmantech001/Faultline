"""Tool handlers for the Faultline Hermes Agent plugin."""

from __future__ import annotations

import json
from typing import Any, Dict

from . import proxy_engine


def _json_out(payload: Dict[str, Any]) -> str:
    return json.dumps(payload, indent=2, sort_keys=False)


def handle_faultline_proxy(args: Dict[str, Any], **kwargs: Any) -> str:
    action = str(args.get("action") or "status").lower()
    listen_port = int(args.get("listen_port", 0) or 0)
    target_url = str(args.get("target_url") or "http://127.0.0.1:8000")

    if action == "start":
        result = proxy_engine.start_proxy(listen_port=listen_port, target_url=target_url)
    elif action == "stop":
        port_arg = listen_port if listen_port > 0 else None
        result = proxy_engine.stop_proxy(listen_port=port_arg)
    else:
        result = proxy_engine.get_proxy_status()
    return _json_out(result)


def handle_faultline_traces(args: Dict[str, Any], **kwargs: Any) -> str:
    trace_id = args.get("trace_id")
    if trace_id:
        return _json_out(proxy_engine.get_trace(str(trace_id)))

    result = proxy_engine.query_traces(
        limit=int(args.get("limit", 25) or 25),
        method=args.get("method"),
        status_filter=args.get("status_filter"),
        path_contains=args.get("path_contains"),
        only_drifts=bool(args.get("only_drifts", False)),
    )
    return _json_out(result)


def handle_faultline_replay(args: Dict[str, Any], **kwargs: Any) -> str:
    trace_id = str(args.get("trace_id") or "").strip()
    if not trace_id:
        return _json_out({"ok": False, "error": "trace_id is required"})

    result = proxy_engine.replay_trace(
        trace_id=trace_id,
        target_url=args.get("target_url"),
        override_headers=args.get("override_headers"),
        override_body=args.get("override_body"),
    )
    return _json_out(result)


def handle_faultline_contract(args: Dict[str, Any], **kwargs: Any) -> str:
    spec = proxy_engine.generate_openapi_spec()
    action = str(args.get("action") or "summary").lower()
    endpoint_filter = str(args.get("endpoint") or "").strip()

    if endpoint_filter:
        spec["contracts"] = [
            c for c in spec["contracts"] if endpoint_filter.lower() in c["contract_key"].lower()
        ]
        spec["recent_drifts"] = [
            d for d in spec["recent_drifts"] if endpoint_filter.lower() in d["path"].lower()
        ]

    if action == "summary":
        return _json_out(
            {
                "ok": True,
                "contract_count": spec["contract_count"],
                "drift_trace_count": spec["drift_trace_count"],
                "contracts": spec["contracts"],
                "recent_drifts": spec["recent_drifts"],
            }
        )
    return _json_out(spec)


def handle_faultline_chaos(args: Dict[str, Any], **kwargs: Any) -> str:
    action = str(args.get("action") or "list").lower()
    if action == "add":
        res = proxy_engine.add_chaos_rule(
            path_pattern=str(args.get("path_pattern") or "/api/"),
            method=str(args.get("method") or "ANY"),
            fault_type=str(args.get("fault_type") or "status_code"),
            status_code=int(args.get("status_code", 503) or 503),
            latency_ms=int(args.get("latency_ms", 0) or 0),
            probability=float(args.get("probability", 1.0) if args.get("probability") is not None else 1.0),
            response_body=str(args.get("response_body") or ""),
        )
        return _json_out(res)
    if action == "remove":
        rule_id = str(args.get("rule_id") or "").strip()
        if not rule_id:
            return _json_out({"ok": False, "error": "rule_id is required for action='remove'"})
        return _json_out(proxy_engine.remove_chaos_rule(rule_id))
    if action == "clear":
        return _json_out(proxy_engine.clear_chaos_rules())
    return _json_out(proxy_engine.list_chaos_rules())


def handle_faultline_simulate(args: Dict[str, Any], **kwargs: Any) -> str:
    scenario = str(args.get("scenario") or "checkout_pipeline")
    return _json_out(proxy_engine.run_live_simulation(scenario=scenario))
