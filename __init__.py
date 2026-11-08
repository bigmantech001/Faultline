"""Faultline plugin entry point for Hermes Agent."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from . import proxy_engine, schemas, tools


def _tool_execution_middleware(
    tool_name: str,
    args: Dict[str, Any],
    next_fn: Callable[[str, Dict[str, Any]], str],
    context: Any,
) -> str:
    """Measure tool execution duration and annotate Faultline telemetry."""
    started = time.perf_counter()
    result = next_fn(tool_name, args)
    elapsed_ms = round((time.perf_counter() - started) * 1000.0, 2)
    if tool_name.startswith("faultline_") and isinstance(result, str) and result.startswith("{"):
        try:
            parsed = json.loads(result)
            if isinstance(parsed, dict) and "middleware_latency_ms" not in parsed:
                parsed["middleware_latency_ms"] = elapsed_ms
                return json.dumps(parsed, indent=2)
        except Exception:
            pass
    return result


def _on_post_tool_call(
    tool_name: str = "",
    args: Optional[Dict[str, Any]] = None,
    result: Any = None,
    task_id: str = "",
    **kwargs: Any,
) -> None:
    if not tool_name or not tool_name.startswith("faultline_"):
        return
    proxy_engine.broadcast_plugin_event(
        proxy_engine.PLUGIN_NAME,
        "tool.completed",
        {"tool_name": tool_name, "task_id": task_id},
    )


def _on_session_start(session_id: str = "", platform: str = "cli", **kwargs: Any) -> None:
    status = proxy_engine.get_proxy_status()
    proxy_engine.broadcast_plugin_event(
        proxy_engine.PLUGIN_NAME,
        "session.started",
        {
            "session_id": session_id,
            "platform": platform,
            "active_proxies": len(status.get("active_proxies") or []),
            "total_traces": status.get("summary", {}).get("total_traces", 0),
        },
    )


def _slash_faultline_handler(args_text: str = "", **kwargs: Any) -> str:
    parts = (args_text or "").strip().split()
    sub = parts[0].lower() if parts else "status"

    if sub in ("sim", "simulate", "demo"):
        sim = proxy_engine.run_live_simulation()
        rpl = sim.get("replay_verification") or {}
        return (
            f"Faultline Live Simulation Complete:\n"
            f"- Failed Checkout Trace: `{sim.get('failed_trace_id')}`\n"
            f"- Schema Drift Trace: `{sim.get('drift_trace_id')}`\n"
            f"- Deterministic Replay: `{rpl.get('status_transition')}` "
            f"(resolved={rpl.get('resolved_error')})\n"
            f"- Learned Endpoints: {sim.get('contract_summary', {}).get('learned_endpoints', 0)}\n"
            f"{sim.get('directive', '')}"
        )

    if sub == "replay" and len(parts) > 1:
        rpl = proxy_engine.replay_trace(parts[1])
        if not rpl.get("ok"):
            return f"Faultline replay failed: {rpl.get('error')}"
        return (
            f"Faultline Replay `{rpl['replay_id']}`: `{rpl['method']} {rpl['path']}` -> "
            f"`{rpl['status_transition']}` ({rpl['new_latency_ms']}ms)\n{rpl['directive']}"
        )

    status = proxy_engine.get_proxy_status()
    summary = status.get("summary") or {}
    return (
        f"Faultline Flight Recorder Status:\n"
        f"- Active Proxies: {len(status.get('active_proxies') or [])}\n"
        f"- Captured Traces: {summary.get('total_traces', 0)} "
        f"(5xx: {summary.get('count_5xx', 0)}, 4xx: {summary.get('count_4xx', 0)}, Drifts: {summary.get('drift_traces', 0)})\n"
        f"- Learned OpenAPI Contracts: {status.get('contract_count', 0)}\n"
        f"- Active Chaos Rules: {status.get('chaos_rule_count', 0)}\n"
        f"Run `/faultline simulate` to launch a live capture + contract drift + replay verification run."
    )


def _setup_cli_parser(parser: argparse.ArgumentParser) -> None:
    sub = parser.add_subparsers(dest="faultline_cmd")
    sub.add_parser("status", help="Show active Faultline proxies, trace counts, and contract stats")
    sub.add_parser("simulate", help="Run an end-to-end live capture, contract drift, chaos, and replay simulation")
    rpl = sub.add_parser("replay", help="Replay a captured trace ID")
    rpl.add_argument("trace_id", help="Trace ID (e.g. flt-a1b2c3d4)")
    sub.add_parser("contracts", help="Print synthesized OpenAPI 3.1 contract JSON")


def _cli_faultline_handler(args: argparse.Namespace) -> None:
    cmd = getattr(args, "faultline_cmd", None) or "status"
    if cmd == "simulate":
        print(json.dumps(proxy_engine.run_live_simulation(), indent=2))
    elif cmd == "replay":
        print(json.dumps(proxy_engine.replay_trace(getattr(args, "trace_id", "")), indent=2))
    elif cmd == "contracts":
        print(json.dumps(proxy_engine.generate_openapi_spec(), indent=2))
    else:
        print(json.dumps(proxy_engine.get_proxy_status(), indent=2))


def register(ctx: Any) -> None:
    """Register Faultline tools, hooks, middleware, slash commands, CLI commands, and skill."""
    ctx.register_tool(
        name="faultline_proxy",
        toolset="faultline",
        schema=schemas.FAULTLINE_PROXY_SCHEMA,
        handler=tools.handle_faultline_proxy,
        description=schemas.FAULTLINE_PROXY_SCHEMA["description"],
        emoji="🛰️",
    )
    ctx.register_tool(
        name="faultline_traces",
        toolset="faultline",
        schema=schemas.FAULTLINE_TRACES_SCHEMA,
        handler=tools.handle_faultline_traces,
        description=schemas.FAULTLINE_TRACES_SCHEMA["description"],
        emoji="📡",
    )
    ctx.register_tool(
        name="faultline_replay",
        toolset="faultline",
        schema=schemas.FAULTLINE_REPLAY_SCHEMA,
        handler=tools.handle_faultline_replay,
        description=schemas.FAULTLINE_REPLAY_SCHEMA["description"],
        emoji="🔁",
    )
    ctx.register_tool(
        name="faultline_contract",
        toolset="faultline",
        schema=schemas.FAULTLINE_CONTRACT_SCHEMA,
        handler=tools.handle_faultline_contract,
        description=schemas.FAULTLINE_CONTRACT_SCHEMA["description"],
        emoji="📜",
    )
    ctx.register_tool(
        name="faultline_chaos",
        toolset="faultline",
        schema=schemas.FAULTLINE_CHAOS_SCHEMA,
        handler=tools.handle_faultline_chaos,
        description=schemas.FAULTLINE_CHAOS_SCHEMA["description"],
        emoji="⚡",
    )
    ctx.register_tool(
        name="faultline_simulate",
        toolset="faultline",
        schema=schemas.FAULTLINE_SIMULATE_SCHEMA,
        handler=tools.handle_faultline_simulate,
        description=schemas.FAULTLINE_SIMULATE_SCHEMA["description"],
        emoji="🧪",
    )

    ctx.register_hook("post_tool_call", _on_post_tool_call)
    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_middleware("tool_execution", _tool_execution_middleware)

    ctx.register_command(
        "faultline",
        _slash_faultline_handler,
        description="Inspect HTTP flight recorder traces, OpenAPI contract drifts, chaos rules, or run a live replay simulation",
        args_hint="[status|simulate|replay <trace_id>]",
    )

    ctx.register_cli_command(
        "faultline",
        "Faultline local API flight recorder, OpenAPI contract verifier, and deterministic replay studio",
        _setup_cli_parser,
        _cli_faultline_handler,
    )

    skill_path = Path(__file__).resolve().parent / "skills" / "faultline-studio" / "SKILL.md"
    if skill_path.is_file():
        ctx.register_skill(
            "faultline-studio",
            skill_path,
            description="Local HTTP flight recorder, OpenAPI 3.1 contract drift verifier, chaos fault injector, and deterministic trace replay workflow",
        )
