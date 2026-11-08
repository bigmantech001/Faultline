"""Self-contained live showcase for Faultline (API Flight Recorder, Contract Drift Verifier & Chaos Replay Studio)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from Faultline import proxy_engine  # noqa: E402


def main() -> None:
    print("=" * 78)
    print("  FAULTLINE — Local API Flight Recorder, OpenAPI Drift Verifier & Chaos Studio")
    print("=" * 78)
    print("\n[1/4] Spinning up loopback microservice + Faultline Reverse Proxy (127.0.0.1)...")
    result = proxy_engine.run_live_simulation(scenario="checkout_pipeline")

    print("\n[2/4] Captured HTTP Waterfall Summary:")
    summary = result["trace_summary"]
    print(f"  • Total Captured Traces : {summary['total_traces']}")
    print(f"  • 5xx Server Faults     : {summary['count_5xx']}")
    print(f"  • 4xx Client/Chaos Hits : {summary['count_4xx']}")
    print(f"  • OpenAPI Drift Traces  : {summary['drift_traces']}")
    print(f"  • Avg Latency           : {summary['avg_latency_ms']} ms")

    print("\n[3/4] Learned OpenAPI 3.1 Contract & Schema Drift Audit:")
    spec = proxy_engine.generate_openapi_spec()
    for c in spec["contracts"]:
        print(
            f"  • {c['contract_key']:<26} | expected={c['expected_status']} | "
            f"baseline={c['baseline_latency_ms']}ms | samples={c['sample_count']}"
        )
    for d in spec["recent_drifts"][:3]:
        first_msg = d["drifts"][0]["message"] if d["drifts"] else "drift"
        print(f"  ! Drift on {d['method']} {d['path']} (trace {d['trace_id']}): {first_msg}")

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
