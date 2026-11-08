"""Unit and integration test suite for the Faultline Hermes Agent plugin."""

from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from Faultline import proxy_engine, register


class _DummyContext:
    def __init__(self) -> None:
        self.tools = {}
        self.hooks = {}
        self.middlewares = {}
        self.slash_commands = {}
        self.cli_commands = {}
        self.skills = {}

    def register_tool(self, name: str, **kwargs) -> None:
        self.tools[name] = kwargs

    def register_hook(self, name: str, handler) -> None:
        self.hooks.setdefault(name, []).append(handler)

    def register_middleware(self, name: str, handler) -> None:
        self.middlewares[name] = handler

    def register_command(self, name: str, handler, **kwargs) -> None:
        self.slash_commands[name] = {"handler": handler, **kwargs}

    def register_cli_command(self, name: str, help_text: str, setup_parser, handler, **kwargs) -> None:
        self.cli_commands[name] = {"help": help_text, "setup_parser": setup_parser, "handler": handler, **kwargs}

    def register_skill(self, name: str, path: Path, **kwargs) -> None:
        self.skills[name] = path


class TestFaultlinePlugin(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = Path(tempfile.mkdtemp(prefix="faultline_test_"))

    def tearDown(self) -> None:
        proxy_engine.stop_proxy()
        proxy_engine.close_cached_dbs()
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_register_capabilities(self) -> None:
        ctx = _DummyContext()
        register(ctx)
        self.assertEqual(
            set(ctx.tools.keys()),
            {
                "faultline_proxy",
                "faultline_traces",
                "faultline_replay",
                "faultline_contract",
                "faultline_chaos",
                "faultline_simulate",
            },
        )
        self.assertIn("post_tool_call", ctx.hooks)
        self.assertIn("on_session_start", ctx.hooks)
        self.assertIn("tool_execution", ctx.middlewares)
        self.assertIn("faultline", ctx.slash_commands)
        self.assertIn("faultline", ctx.cli_commands)
        self.assertIn("faultline-studio", ctx.skills)

    def test_redaction_and_contract_drift(self) -> None:
        # Baseline 200 OK trace learns OpenAPI contract
        t1 = proxy_engine.record_trace(
            method="GET",
            path="/api/v1/users/42",
            target_url="http://127.0.0.1:9000",
            request_headers={"Authorization": "Bearer secret_jwt_token_123", "Accept": "application/json"},
            request_body="",
            response_status=200,
            response_headers={"Content-Type": "application/json", "Set-Cookie": "sid=topsecret"},
            response_body='{"user_id": 42, "credits": 100, "plan": "pro", "api_key": "sk_live_999"}',
            latency_ms=12.4,
            data_dir=self.temp_dir,
        )
        self.assertEqual(t1["request_headers"]["Authorization"], "[REDACTED]")
        self.assertEqual(t1["response_headers"]["Set-Cookie"], "[REDACTED]")
        self.assertIn('"api_key": "[REDACTED]"', t1["response_body"])
        self.assertEqual(len(t1["drifts"]), 0)

        # Second trace on /api/v1/users/99 introduces type mismatch (credits is string) and omits `plan`
        t2 = proxy_engine.record_trace(
            method="GET",
            path="/api/v1/users/99",
            target_url="http://127.0.0.1:9000",
            request_headers={"Accept": "application/json"},
            request_body="",
            response_status=200,
            response_headers={"Content-Type": "application/json"},
            response_body='{"user_id": 99, "credits": "one-hundred"}',
            latency_ms=15.1,
            data_dir=self.temp_dir,
        )
        drift_kinds = {d["kind"] for d in t2["drifts"]}
        self.assertIn("type_mismatch", drift_kinds)
        self.assertIn("missing_required_field", drift_kinds)

        spec = proxy_engine.generate_openapi_spec(data_dir=self.temp_dir)
        self.assertEqual(spec["contract_count"], 1)
        self.assertIn("/api/v1/users/{id}", spec["openapi"]["paths"])

    def test_live_simulation_and_deterministic_replay(self) -> None:
        sim = proxy_engine.run_live_simulation(scenario="checkout_pipeline", data_dir=self.temp_dir)
        self.assertTrue(sim["ok"])
        replay = sim["replay_verification"]
        self.assertTrue(replay["ok"])
        self.assertEqual(replay["old_status"], 500)
        self.assertEqual(replay["new_status"], 200)
        self.assertEqual(replay["status_transition"], "500 -> 200")
        self.assertTrue(replay["resolved_error"])
        self.assertGreaterEqual(sim["contract_summary"]["learned_endpoints"], 2)
        self.assertGreaterEqual(sim["contract_summary"]["drift_traces_detected"], 2)


if __name__ == "__main__":
    unittest.main()
