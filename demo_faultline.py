"""Self-contained live showcase for Faultline (API Flight Recorder, Contract Drift Verifier & Chaos Replay Studio)."""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def _load_plugin_package():
    """Import the plugin as package ``faultline`` whatever the checkout folder is called."""
    spec = importlib.util.spec_from_file_location(
        "faultline", ROOT / "__init__.py", submodule_search_locations=[str(ROOT)]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules["faultline"] = module
    spec.loader.exec_module(module)
    return module


proxy_engine = _load_plugin_package().proxy_engine
# The standalone demo records into a throwaway directory so it never touches ~/.hermes.
DEMO_DATA_DIR = Path(tempfile.mkdtemp(prefix="faultline_demo_"))


def main() -> None:
    print("=" * 78)
    print("  FAULTLINE — Local API Flight Recorder, OpenAPI Drift Verifier & Chaos Studio")
    print("=" * 78)
    print("\n[1/4] Spinning up loopback microservice + Faultline Reverse Proxy (127.0.0.1)...")
    result = proxy_engine.run_live_simulation(scenario="checkout_pipeline", data_dir=DEMO_DATA_DIR)

    print("\n[2/4] Captured HTTP Waterfall Summary:")
    summary = result["trace_summary"]
    print(f"  • Total Captured Traces : {summary['total_traces']}")
    print(f"  • 5xx Server Faults     : {summary['count_5xx']}")
    print(f"  • 4xx Client/Chaos Hits : {summary['count_4xx']}")
    print(f"  • OpenAPI Drift Traces  : {summary['drift_traces']}")
    print(f"  • Avg Latency           : {summary['avg_latency_ms']} ms")

    print("\n[3/4] Learned OpenAPI 3.1 Contract & Schema Drift Audit:")
    spec = proxy_engine.generate_openapi_spec(data_dir=DEMO_DATA_DIR)
    for c in spec["contracts"]:
        print(
            f"  • {c['contract_key']:<26} | expected={c['expected_status']} | "
            f"baseline={c['baseline_latency_ms']}ms | samples={c['sample_count']}"
        )
    for d in spec["recent_drifts"]:
        if d["path"].startswith("/api/v1/webhooks"):
            continue  # chaos-injected 429, shown in the summary above
        for finding in d["drifts"]:
            print(f"  ! {d['method']} {d['path']} (trace {d['trace_id']}): {finding['message']}")

    print("\n[4/4] Deterministic Trace Replay Verification (After Hotfix):")
    rpl = result["replay_verification"]
    print(f"  • Original Failed Trace : {rpl['original_trace_id']} (HTTP {rpl['old_status']})")
    print(f"  • Replay Verification   : {rpl['replay_trace_id']} (HTTP {rpl['new_status']})")
    print(f"  • Transition            : {rpl['status_transition']} | Bug Resolved: {rpl['resolved_error']}")
    print(f"  • Replay Response Body  : {json.dumps(json.loads(rpl['replay_response_body']))}")
    print(f"  • Transcript Directive  : {result['directive']}")
    print("=" * 78)


if __name__ == "__main__":
    main()
