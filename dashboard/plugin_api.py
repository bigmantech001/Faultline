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

def _load_proxy_engine():
    """Locate the plugin's engine however this file was loaded.

    Hermes executes ``dashboard/plugin_api.py`` as a flat module (``hermes_dashboard_plugin_faultline``,
    no parent package), both in-process and in the plugin host, so a relative import fails there.
    Order of preference:
    1. package-relative import (tests and tools import this module as ``<pkg>.dashboard.plugin_api``);
    2. the module the Hermes plugin loader already imported for the agent half
       (``hermes_plugins.faultline.proxy_engine``), so the dashboard routes and the agent tools share one
       in-memory state: active proxies, cached DB connections, settings;
    3. a standalone load of ``proxy_engine.py`` by path (it has no relative imports of its own).
    """
    if __package__:
        try:
            from .. import proxy_engine as pkg_engine  # type: ignore[no-redef]

            return pkg_engine
        except ImportError:
            pass

    import sys

    def _is_engine(mod: object) -> bool:
        return getattr(mod, "PLUGIN_NAME", None) == "faultline" and hasattr(mod, "get_proxy_status")

    # The Hermes plugin loader's namespace first (hermes_plugins.<slug>[__home_<digest>]), then any
    # other import of the same file (a test runner or a tool that imported the package under another name).
    from pathlib import Path

    here = Path(__file__).resolve().parents[1]

    def _same_checkout(mod: object) -> bool:
        try:
            return Path(getattr(mod, "__file__", "") or "").resolve().parent == here
        except (OSError, ValueError):
            return False

    candidates = [(n, m) for n, m in list(sys.modules.items()) if n.endswith(".proxy_engine") and _is_engine(m)]
    for prefer_same_checkout in (True, False):
        for name, mod in candidates:
            if name.startswith("hermes_plugins.") and (_same_checkout(mod) or not prefer_same_checkout):
                return mod
    for _name, mod in candidates:
        return mod

    import importlib.util

    engine_path = here / "proxy_engine.py"
    spec = importlib.util.spec_from_file_location("faultline_proxy_engine", engine_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load Faultline engine from {engine_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _install_settings_provider(module)
    return module


def _install_settings_provider(module: Any) -> None:
    """A standalone engine has no ``ctx.get_config``. Read the same ``plugins.entries.faultline.settings``
    keys through Hermes's public config loader, so captures triggered from the dashboard honour the user's
    settings (redaction, body size, latency threshold) exactly like captures triggered by the agent."""
    try:
        from hermes_cli.config import load_config_readonly
    except Exception:
        return

    def _provider(key: str, default: Any = None) -> Any:
        try:
            cfg = load_config_readonly() or {}
        except Exception:
            return default
        entry = (((cfg.get("plugins") or {}).get("entries") or {}).get("faultline") or {})
        for bucket in ("settings", "config"):
            values = entry.get(bucket) if isinstance(entry, dict) else None
            if isinstance(values, dict) and key in values:
                return values[key]
        return default

    setter = getattr(module, "set_settings_provider", None)
    if callable(setter):
        setter(_provider)


proxy_engine = _load_proxy_engine()

# No prefix here: Hermes mounts this router under /api/plugins/faultline itself (in-process via
# include_router(prefix=...), in the plugin host by forwarding only the path after that prefix).
router = APIRouter(tags=["faultline"])


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
