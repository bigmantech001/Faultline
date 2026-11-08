"""FastAPI router for the Faultline Desktop & Dashboard Studio."""

from __future__ import annotations

from typing import Any, Dict, Optional

try:
    from fastapi import APIRouter, Body, Query
except ImportError:
    class APIRouter:  # type: ignore[no-redef]
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            self.routes = []

        def get(self, *args: Any, **kwargs: Any):
            def _wrap(fn):
                return fn
            return _wrap

        def post(self, *args: Any, **kwargs: Any):
            def _wrap(fn):
                return fn
            return _wrap

        def delete(self, *args: Any, **kwargs: Any):
            def _wrap(fn):
                return fn
            return _wrap

    def Body(default: Any = None, **kwargs: Any) -> Any:  # type: ignore[misc]
        return default

    def Query(default: Any = None, **kwargs: Any) -> Any:  # type: ignore[misc]
        return default

from .. import proxy_engine

router = APIRouter(prefix="/api/plugins/faultline", tags=["faultline"])


@router.get("/status")
def api_status() -> Dict[str, Any]:
    return proxy_engine.get_proxy_status()


@router.get("/traces")
def api_traces(
    limit: int = Query(25, ge=1, le=200),
    method: Optional[str] = Query(None),
    status_filter: Optional[str] = Query(None),
    path_contains: Optional[str] = Query(None),
    only_drifts: bool = Query(False),
) -> Dict[str, Any]:
    return proxy_engine.query_traces(
        limit=limit,
        method=method,
        status_filter=status_filter,
        path_contains=path_contains,
        only_drifts=only_drifts,
    )


@router.get("/traces/{trace_id}")
def api_trace_detail(trace_id: str) -> Dict[str, Any]:
    return proxy_engine.get_trace(trace_id)


@router.post("/replay")
def api_replay_trace(payload: Dict[str, Any] = Body(default={})) -> Dict[str, Any]:
    trace_id = str(payload.get("trace_id") or "").strip()
    if not trace_id:
        return {"ok": False, "error": "trace_id is required"}
    return proxy_engine.replay_trace(
        trace_id=trace_id,
        target_url=payload.get("target_url"),
        override_headers=payload.get("override_headers"),
        override_body=payload.get("override_body"),
    )


@router.get("/contracts")
def api_contracts() -> Dict[str, Any]:
    return proxy_engine.generate_openapi_spec()


@router.get("/chaos")
def api_chaos_list() -> Dict[str, Any]:
    return proxy_engine.list_chaos_rules()


@router.post("/chaos")
def api_chaos_add(payload: Dict[str, Any] = Body(default={})) -> Dict[str, Any]:
    return proxy_engine.add_chaos_rule(
        path_pattern=str(payload.get("path_pattern") or "/api/"),
        method=str(payload.get("method") or "ANY"),
        fault_type=str(payload.get("fault_type") or "status_code"),
        status_code=int(payload.get("status_code", 503) or 503),
        latency_ms=int(payload.get("latency_ms", 0) or 0),
        probability=float(payload.get("probability", 1.0) if payload.get("probability") is not None else 1.0),
        response_body=str(payload.get("response_body") or ""),
    )


@router.delete("/chaos/{rule_id}")
def api_chaos_delete(rule_id: str) -> Dict[str, Any]:
    return proxy_engine.remove_chaos_rule(rule_id)


@router.post("/simulate")
def api_simulate(payload: Dict[str, Any] = Body(default={})) -> Dict[str, Any]:
    scenario = str((payload or {}).get("scenario") or "checkout_pipeline")
    return proxy_engine.run_live_simulation(scenario=scenario)
