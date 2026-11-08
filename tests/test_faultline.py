"""Unit and integration test suite for the Faultline Hermes Agent plugin."""

from __future__ import annotations

import http.server
import importlib.util
import json
import shutil
import socket
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_plugin_package():
    """Import the plugin as package ``faultline`` whatever the checkout folder is called."""
    name = "faultline"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(
        name, ROOT / "__init__.py", submodule_search_locations=[str(ROOT)]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


faultline = _load_plugin_package()
proxy_engine = faultline.proxy_engine
register = faultline.register


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
        proxy_engine.set_settings_provider(None)
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


    def test_tool_execution_middleware_matches_hermes_contract(self) -> None:
        """Hermes calls execution middleware with keyword args (tool_name, args, next_call, ...)."""
        calls = []

        def next_call(payload=None):
            calls.append(payload)
            return json.dumps({"ok": True})

        out = faultline._tool_execution_middleware(
            tool_name="faultline_traces",
            args={"limit": 5},
            next_call=next_call,
            original_args={"limit": 5},
            session_id="s1",
            middleware_schema_version="hermes.middleware.v1",
        )
        self.assertEqual(calls, [{"limit": 5}])
        self.assertIn("middleware_latency_ms", json.loads(out))

        calls.clear()
        passthrough = faultline._tool_execution_middleware(
            tool_name="read_file", args={"path": "x"}, next_call=lambda a: calls.append(a) or "raw"
        )
        self.assertEqual(passthrough, "raw")
        self.assertEqual(calls, [{"path": "x"}])

    def test_slash_command_and_cli_parser(self) -> None:
        ctx = _DummyContext()
        register(ctx)
        text = ctx.slash_commands["faultline"]["handler"]("status")
        self.assertIn("Faultline Flight Recorder Status", text)
        missing = ctx.slash_commands["faultline"]["handler"]("replay flt-00000000")
        self.assertIn("not found", missing)

    def test_settings_drive_redaction_truncation_and_latency(self) -> None:
        settings = {"auto_redact_headers": False, "max_body_chars": 300, "latency_spike_threshold_ms": 50}
        proxy_engine.set_settings_provider(lambda key, default=None: settings.get(key, default))
        trace = proxy_engine.record_trace(
            method="POST",
            path="/api/slow",
            target_url="http://127.0.0.1:9000",
            request_headers={"Authorization": "Basic abc"},
            request_body="x" * 1000,
            response_status=200,
            response_headers={},
            response_body="{}",
            latency_ms=75.0,
            data_dir=self.temp_dir,
        )
        self.assertEqual(trace["request_headers"]["Authorization"], "Basic abc")
        self.assertTrue(trace["request_body"].startswith("x" * 300))
        self.assertIn("[truncated 700 chars]", trace["request_body"])
        self.assertIn("latency_regression", {d["kind"] for d in trace["drifts"]})

    def test_invalid_target_url_is_rejected(self) -> None:
        res = proxy_engine.start_proxy(listen_port=0, target_url="file:///etc/passwd", data_dir=self.temp_dir)
        self.assertFalse(res["ok"])
        self.assertIn("http(s)", res["error"])

    def test_proxy_forwards_headers_redirects_head_and_concurrency(self) -> None:
        class Upstream(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                return

            def do_GET(self):
                if self.path == "/login":
                    self.send_response(302)
                    self.send_header("Location", "/home")
                    self.send_header("Set-Cookie", "sid=abc; HttpOnly")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                body = json.dumps({"n": int(self.path.rsplit("/", 1)[-1] or 0)}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("X-Upstream", "yes")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            do_HEAD = do_GET

        upstream = proxy_engine._ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        try:
            info = proxy_engine.start_proxy(
                listen_port=0,
                target_url=f"http://127.0.0.1:{upstream.server_address[1]}",
                data_dir=self.temp_dir,
            )
            self.assertTrue(info["ok"])
            base = info["proxy_url"]

            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, *a, **k):
                    return None

            opener = urllib.request.build_opener(NoRedirect)
            with self.assertRaises(urllib.error.HTTPError) as cm:
                opener.open(f"{base}/login", timeout=5)
            self.assertEqual(cm.exception.code, 302)
            self.assertEqual(cm.exception.headers.get("Location"), "/home")
            self.assertIn("sid=abc", cm.exception.headers.get("Set-Cookie", ""))
            cm.exception.close()

            with urllib.request.urlopen(urllib.request.Request(f"{base}/items/1", method="HEAD"), timeout=5) as r:
                self.assertEqual(r.status, 200)
                self.assertEqual(r.headers.get("X-Upstream"), "yes")

            def hit(i):
                with urllib.request.urlopen(f"{base}/items/{i}", timeout=10) as r:
                    return json.loads(r.read())["n"]

            with ThreadPoolExecutor(max_workers=12) as pool:
                results = sorted(pool.map(hit, range(40)))
            self.assertEqual(results, list(range(40)))

            summary = proxy_engine.query_traces(limit=200, data_dir=self.temp_dir)["summary"]
            self.assertEqual(summary["total_traces"], 42)
            self.assertEqual(summary["count_5xx"], 0)
        finally:
            upstream.shutdown()
            upstream.server_close()


    def test_active_proxy_registry_is_shared_across_processes(self) -> None:
        info = proxy_engine.start_proxy(listen_port=0, target_url="http://127.0.0.1:9", data_dir=self.temp_dir)
        self.assertTrue(info["ok"])
        port = info["listen_port"]
        status = proxy_engine.get_proxy_status(data_dir=self.temp_dir)
        self.assertEqual([p["listen_port"] for p in status["active_proxies"]], [port])

        # Rows another process wrote: a port that still accepts connections is reported, a dead one is pruned.
        live = socket.socket()
        live.bind(("127.0.0.1", 0))
        live.listen(1)
        live_port = live.getsockname()[1]
        dead = socket.socket()  # bound but never listening, so nothing else can take the port meanwhile
        dead.bind(("127.0.0.1", 0))
        dead_port = dead.getsockname()[1]
        conn = proxy_engine.get_db(self.temp_dir)
        for p in (live_port, dead_port):
            conn.execute(
                "INSERT INTO active_proxies (listen_port, target_url, started_at, pid) VALUES (?, ?, ?, ?)",
                (p, "http://127.0.0.1:8000", "2026-01-01T00:00:00+00:00", 999999),
            )
        conn.commit()
        try:
            listed = proxy_engine.get_proxy_status(data_dir=self.temp_dir)["active_proxies"]
            self.assertEqual(sorted(p["listen_port"] for p in listed), sorted([port, live_port]))
            self.assertEqual([p["owner"] for p in listed if p["listen_port"] == live_port], ["other-process"])
            remaining = [r[0] for r in conn.execute("SELECT listen_port FROM active_proxies").fetchall()]
            self.assertNotIn(dead_port, remaining)
        finally:
            live.close()
            dead.close()

        proxy_engine.stop_proxy(port)
        self.assertEqual(proxy_engine.get_proxy_status(data_dir=self.temp_dir)["active_proxies"], [])


    def test_registry_survives_two_engine_copies_in_one_process(self) -> None:
        """The dashboard router can run a second copy of the engine in the same process as the agent
        half; it must list the proxies the other copy owns and never prune their rows."""
        spec = importlib.util.spec_from_file_location("faultline_engine_copy_b", ROOT / "proxy_engine.py")
        copy_b = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(copy_b)

        info = proxy_engine.start_proxy(listen_port=0, target_url="http://127.0.0.1:9", data_dir=self.temp_dir)
        try:
            seen = copy_b.get_proxy_status(data_dir=self.temp_dir)["active_proxies"]
            self.assertEqual([(p["listen_port"], p["owner"]) for p in seen], [(info["listen_port"], "this-process")])
            rows = proxy_engine.get_db(self.temp_dir).execute("SELECT listen_port FROM active_proxies").fetchall()
            self.assertEqual([r[0] for r in rows], [info["listen_port"]])
        finally:
            proxy_engine.stop_proxy(info["listen_port"])
        self.assertEqual(copy_b.get_proxy_status(data_dir=self.temp_dir)["active_proxies"], [])
        copy_b.close_cached_dbs()


if __name__ == "__main__":
    unittest.main()
