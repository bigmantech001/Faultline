"""Tool handlers for the Faultline Hermes Agent plugin.

Each handler receives the JSON arguments the model produced (``args``) and returns a JSON string.
The names a handler reads are exactly the properties its schema in ``schemas.py`` declares, plus the
aliases in ``ALIASES`` that older skill and README text used. Enum values come from the schema, so a
value the schema does not list gets a precise error instead of a silent default.
``tests/test_faultline.py`` checks both directions of that contract.
"""

from __future__ import annotations

import functools
import json
from typing import Any, Callable, Dict, Optional, Tuple

from . import proxy_engine, schemas

# alias name read by the handler -> the declared parameter it stands for
ALIASES: Dict[str, Dict[str, str]] = {
    "faultline_proxy": {"upstream_url": "target_url"},
    "faultline_chaos": {"path_prefix": "path_pattern"},
}

DEFAULT_TARGET_URL = "http://127.0.0.1:8000"
DEFAULT_CHAOS_PATH_PATTERN = "/api/"


class _ArgError(ValueError):
    """A tool argument the schema does not allow; reported as ``{"ok": false, "error": ...}``."""


def _json_out(payload: Dict[str, Any]) -> str:
    return json.dumps(payload, indent=2, sort_keys=False)


def _enum(schema: Dict[str, Any], prop: str) -> Tuple[str, ...]:
    return tuple(schema["parameters"]["properties"][prop]["enum"])


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value)
    return str(value).strip()


def _choice(value: Any, name: str, allowed: Tuple[str, ...], default: str) -> str:
    text = _text(value).lower() or default
    if text not in allowed:
        raise _ArgError(f"Unknown {name} {text!r}. Use one of: {', '.join(allowed)}.")
    return text


def _int(value: Any, name: str, default: int) -> int:
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        raise _ArgError(f"{name} must be an integer, got {value!r}.")
    try:
        return int(value)
    except (TypeError, ValueError):
        raise _ArgError(f"{name} must be an integer, got {value!r}.") from None


def _float(value: Any, name: str, default: float) -> float:
    if value is None or value == "":
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        raise _ArgError(f"{name} must be a number, got {value!r}.") from None


def _bool(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return bool(value)


def _handler(fn: Callable[..., str]) -> Callable[..., str]:
    """Turn ``_ArgError`` into a JSON error so a bad argument never raises into Hermes."""

    @functools.wraps(fn)
    def wrapper(args: Optional[Dict[str, Any]] = None, **kwargs: Any) -> str:
        try:
            return fn(dict(args or {}), **kwargs)
        except _ArgError as exc:
            return _json_out({"ok": False, "error": str(exc)})

    return wrapper


@_handler
def handle_faultline_proxy(args: Dict[str, Any], **kwargs: Any) -> str:
    action = _choice(args.get("action"), "action", _enum(schemas.FAULTLINE_PROXY, "action"), "status")
    listen_port = _int(args.get("listen_port"), "listen_port", 0)
    # ``upstream_url`` is the alias older callers used for ``target_url``.
    target_url = _text(args.get("target_url")) or _text(args.get("upstream_url")) or DEFAULT_TARGET_URL

    if action == "start":
        return _json_out(proxy_engine.start_proxy(listen_port=listen_port, target_url=target_url))
    if action == "stop":
        return _json_out(proxy_engine.stop_proxy(listen_port=listen_port if listen_port > 0 else None))
    if action == "clear":
        return _json_out(proxy_engine.clear_recorder())
    return _json_out(proxy_engine.get_proxy_status())


@_handler
def handle_faultline_traces(args: Dict[str, Any], **kwargs: Any) -> str:
    trace_id = _text(args.get("trace_id"))
    if trace_id:
        return _json_out(proxy_engine.get_trace(trace_id))

    status_filter = _choice(
        args.get("status_filter"), "status_filter", _enum(schemas.FAULTLINE_TRACES, "status_filter"), "all"
    )
    # ``drifted`` and ``replayed`` are handled inside query_traces; ``only_drifts`` is the boolean spelling.
    result = proxy_engine.query_traces(
        limit=_int(args.get("limit"), "limit", 25),
        method=_text(args.get("method")) or None,
        status_filter=status_filter,
        path_contains=_text(args.get("path_contains")) or None,
        only_drifts=_bool(args.get("only_drifts")),
    )
    return _json_out(result)


@_handler
def handle_faultline_replay(args: Dict[str, Any], **kwargs: Any) -> str:
    trace_id = _text(args.get("trace_id"))
    if not trace_id:
        raise _ArgError("trace_id is required.")

    override_headers = args.get("override_headers")
    if override_headers is not None and not isinstance(override_headers, dict):
        raise _ArgError("override_headers must be an object of header name to value.")
    override_body = args.get("override_body")
    if override_body is not None and not isinstance(override_body, str):
        override_body = _text(override_body)

    result = proxy_engine.replay_trace(
        trace_id=trace_id,
        target_url=_text(args.get("target_url")) or None,
        override_headers=override_headers,
        override_body=override_body,
    )
    return _json_out(result)


def _endpoint_matches(endpoint: str, method: str, path: str) -> bool:
    """Case-insensitive substring match of ``endpoint`` against the raw path, the normalized path, and
    both prefixed with the method (``'GET /api/v1/orders/{id}'``)."""
    needle = endpoint.lower()
    normalized = proxy_engine.normalize_route_path(path)
    for candidate in (path, normalized, f"{method} {path}", f"{method} {normalized}"):
        if needle in candidate.lower():
            return True
    return False


@_handler
def handle_faultline_contract(args: Dict[str, Any], **kwargs: Any) -> str:
    action = _choice(args.get("action"), "action", _enum(schemas.FAULTLINE_CONTRACT, "action"), "summary")
    export_openapi = _bool(args.get("export_openapi")) or action == "openapi"
    endpoint = _text(args.get("endpoint"))

    spec = proxy_engine.generate_openapi_spec()
    contracts = spec["contracts"]
    drifts = spec["recent_drifts"]
    openapi = spec["openapi"]

    if endpoint:
        contracts = [c for c in contracts if _endpoint_matches(endpoint, c["method"], c["normalized_path"])]
        drifts = [d for d in drifts if _endpoint_matches(endpoint, d["method"], d["path"])]
        wanted = {(c["normalized_path"], c["method"].lower()) for c in contracts}
        paths: Dict[str, Dict[str, Any]] = {}
        for path, ops in openapi["paths"].items():
            kept = {op: body for op, body in ops.items() if (path, op) in wanted}
            if kept:
                paths[path] = kept
        openapi = dict(openapi, paths=paths)

    if export_openapi:
        return _json_out(openapi)

    summary: Dict[str, Any] = {
        "ok": True,
        "contract_count": len(contracts),
        "drift_trace_count": len(drifts),
        "contracts": contracts,
        "recent_drifts": drifts,
    }
    if endpoint:
        summary["endpoint"] = endpoint
    return _json_out(summary)


@_handler
def handle_faultline_chaos(args: Dict[str, Any], **kwargs: Any) -> str:
    action = _choice(args.get("action"), "action", _enum(schemas.FAULTLINE_CHAOS, "action"), "list")

    if action == "add":
        fault_type = _choice(
            args.get("fault_type"), "fault_type", _enum(schemas.FAULTLINE_CHAOS, "fault_type"), "status_code"
        )
        latency_ms = _int(args.get("latency_ms"), "latency_ms", 0)
        if fault_type in ("latency", "latency_and_status") and latency_ms <= 0:
            raise _ArgError(f"latency_ms must be > 0 for fault_type {fault_type!r}.")
        # ``path_prefix`` is the alias older callers used for ``path_pattern``.
        path_pattern = _text(args.get("path_pattern")) or _text(args.get("path_prefix")) or DEFAULT_CHAOS_PATH_PATTERN
        res = proxy_engine.add_chaos_rule(
            path_pattern=path_pattern,
            method=_text(args.get("method")) or "ANY",
            fault_type=fault_type,
            status_code=_int(args.get("status_code"), "status_code", 503),
            latency_ms=latency_ms,
            probability=_float(args.get("probability"), "probability", 1.0),
            response_body=_text(args.get("response_body")),
        )
        return _json_out(res)
    if action == "remove":
        rule_id = _text(args.get("rule_id"))
        if not rule_id:
            raise _ArgError("rule_id is required for action='remove'.")
        return _json_out(proxy_engine.remove_chaos_rule(rule_id))
    if action == "clear":
        return _json_out(proxy_engine.clear_chaos_rules())
    return _json_out(proxy_engine.list_chaos_rules())


@_handler
def handle_faultline_simulate(args: Dict[str, Any], **kwargs: Any) -> str:
    scenario = _choice(
        args.get("scenario"), "scenario", _enum(schemas.FAULTLINE_SIMULATE, "scenario"), "checkout_pipeline"
    )
    return _json_out(proxy_engine.run_live_simulation(scenario=scenario))
