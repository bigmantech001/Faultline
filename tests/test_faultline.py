"""Unit and integration test suite for the Faultline Hermes Agent plugin."""

from __future__ import annotations

import ast
import http.server
import importlib.util
import json
import os
import re
import shutil
import socket
import sys
import tempfile
import threading
import time
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
schemas = faultline.schemas
tools = faultline.tools
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


class TestToolContract(unittest.TestCase):
    """``schemas.py`` is the contract the model sees; ``tools.py`` must accept exactly it."""

    TOOLS = (
        "faultline_proxy",
        "faultline_traces",
        "faultline_replay",
        "faultline_contract",
        "faultline_chaos",
        "faultline_simulate",
    )

    def setUp(self) -> None:
        self.temp_dir = Path(tempfile.mkdtemp(prefix="faultline_tools_"))
        self._saved_home = os.environ.get("HERMES_HOME")
        # The tool handlers use the plugin's default store; point it at the temp dir for the test.
        os.environ["HERMES_HOME"] = str(self.temp_dir)

    def tearDown(self) -> None:
        proxy_engine.stop_proxy()
        proxy_engine.close_cached_dbs()
        if self._saved_home is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = self._saved_home
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    @staticmethod
    def _schema(tool: str) -> dict:
        return next(s for s in schemas.ALL_SCHEMAS if s["name"] == tool)

    @staticmethod
    def _props(tool: str) -> dict:
        return TestToolContract._schema(tool)["parameters"]["properties"]

    def _call(self, tool: str, args: dict) -> dict:
        out = getattr(tools, f"handle_{tool}")(args)
        self.assertIsInstance(out, str)
        res = json.loads(out)
        self.assertIsInstance(res, dict)
        return res

    @staticmethod
    def _names_read(tool: str) -> set:
        """Every ``args.get("x")`` / ``args["x"]`` inside ``handle_<tool>`` in tools.py."""
        tree = ast.parse((ROOT / "tools.py").read_text(encoding="utf-8"))
        fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == f"handle_{tool}")
        names = set()
        for node in ast.walk(fn):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "get"
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "args"
                and node.args
                and isinstance(node.args[0], ast.Constant)
            ):
                names.add(str(node.args[0].value))
            if (
                isinstance(node, ast.Subscript)
                and isinstance(node.value, ast.Name)
                and node.value.id == "args"
                and isinstance(node.slice, ast.Constant)
            ):
                names.add(str(node.slice.value))
        return names

    def test_every_schema_property_is_read_and_nothing_undeclared_is(self) -> None:
        for tool in self.TOOLS:
            with self.subTest(tool=tool):
                schema = self._schema(tool)
                declared = set(schema["parameters"]["properties"])
                read = self._names_read(tool)
                aliases = tools.ALIASES.get(tool, {})
                self.assertEqual(declared - read, set(), f"{tool}: declared in the schema but never read")
                self.assertEqual(read - declared, set(aliases), f"{tool}: read but not declared and not an alias")
                for alias, declared_name in aliases.items():
                    self.assertIn(declared_name, declared)
                    self.assertIn(
                        alias,
                        schema["parameters"]["properties"][declared_name]["description"],
                        f"{tool}: alias {alias!r} is not documented on {declared_name!r}",
                    )
                for required in schema["parameters"].get("required", []):
                    self.assertIn(required, declared)

    def test_every_enum_value_is_handled(self) -> None:
        companions = {
            # 'latency' and 'latency_and_status' need a delay; 'remove' needs a rule id.
            "faultline_chaos": {"path_pattern": "/enum-test", "latency_ms": 50, "rule_id": "chaos-000000"},
        }
        for tool in self.TOOLS:
            for prop, spec in self._props(tool).items():
                for value in spec.get("enum", []):
                    with self.subTest(tool=tool, prop=prop, value=value):
                        args = dict(companions.get(tool, {}))
                        args[prop] = value
                        try:
                            res = self._call(tool, args)
                        except Exception as exc:  # noqa: BLE001
                            self.fail(f"{tool}({prop}={value!r}) raised {exc!r}")
                        if tool == "faultline_contract" and value == "openapi":
                            self.assertEqual(res.get("openapi"), "3.1.0", res)
                        else:
                            self.assertIs(res.get("ok"), True, f"{tool}({prop}={value!r}) -> {res}")
                        if tool == "faultline_proxy" and value == "start":
                            proxy_engine.stop_proxy()

    def test_values_outside_the_schema_get_a_precise_error(self) -> None:
        cases = [
            ("faultline_proxy", {"action": "record"}, "action"),
            ("faultline_proxy", {"action": "start", "listen_port": "eighty"}, "listen_port"),
            ("faultline_traces", {"status_filter": "bogus"}, "status_filter"),
            ("faultline_traces", {"limit": "many"}, "limit"),
            ("faultline_contract", {"action": "export"}, "action"),
            ("faultline_chaos", {"action": "toggle", "rule_id": "chaos-1"}, "action"),
            ("faultline_chaos", {"action": "add", "fault_type": "latency", "path_pattern": "/x"}, "latency_ms"),
            ("faultline_chaos", {"action": "add", "fault_type": "explode"}, "fault_type"),
            ("faultline_chaos", {"action": "remove"}, "rule_id"),
            ("faultline_replay", {}, "trace_id"),
            ("faultline_replay", {"trace_id": "flt-1", "override_headers": "Bearer x"}, "override_headers"),
            ("faultline_simulate", {"scenario": "webhook_chaos"}, "scenario"),
        ]
        for tool, args, needle in cases:
            with self.subTest(tool=tool, args=args):
                res = self._call(tool, args)
                self.assertIs(res.get("ok"), False, res)
                self.assertIn(needle, res.get("error", ""))
        # Rejected calls changed nothing.
        self.assertEqual(proxy_engine.list_chaos_rules()["count"], 0)
        self.assertEqual(proxy_engine.get_proxy_status()["active_proxies"], [])
        self.assertEqual(proxy_engine.query_traces()["summary"]["total_traces"], 0)

    def test_documented_aliases_still_work_and_declared_names_win(self) -> None:
        res = self._call("faultline_proxy", {"action": "start", "upstream_url": "http://127.0.0.1:9"})
        self.assertTrue(res["ok"])
        self.assertEqual(res["target_url"], "http://127.0.0.1:9")
        stopped = self._call("faultline_proxy", {"action": "stop", "listen_port": res["listen_port"]})
        self.assertEqual(stopped["stopped_ports"], [res["listen_port"]])

        rule = self._call("faultline_chaos", {"action": "add", "path_prefix": "/alias", "status_code": 429})
        self.assertEqual(rule["rule"]["path_pattern"], "/alias")
        both = self._call("faultline_chaos", {"action": "add", "path_pattern": "/declared", "path_prefix": "/alias"})
        self.assertEqual(both["rule"]["path_pattern"], "/declared")

    def test_schema_enums_match_engine_constants(self) -> None:
        chaos = self._props("faultline_chaos")
        self.assertEqual(set(chaos["fault_type"]["enum"]), set(proxy_engine.CHAOS_FAULT_TYPES))
        self.assertIn(str(proxy_engine.CHAOS_MAX_LATENCY_MS), chaos["latency_ms"]["description"])
        self.assertEqual(
            set(self._props("faultline_simulate")["scenario"]["enum"]), set(proxy_engine.SUPPORTED_SCENARIOS)
        )

    def test_readme_and_skill_use_declared_parameter_names(self) -> None:
        call_re = re.compile(r"faultline_(proxy|traces|replay|contract|chaos|simulate)\(([^)]*)\)")
        kw_re = re.compile(r"(\w+)=")
        for doc in (ROOT / "README.md", ROOT / "skills" / "faultline-studio" / "SKILL.md"):
            text = doc.read_text(encoding="utf-8")
            calls = call_re.findall(text)
            self.assertTrue(calls, f"{doc.name} shows no tool calls")
            for suffix, arglist in calls:
                tool = f"faultline_{suffix}"
                props = self._props(tool)
                for name in kw_re.findall(arglist):
                    self.assertIn(name, props, f"{doc.name}: {tool}({arglist}) uses undeclared {name!r}")
                for prop, spec in props.items():
                    quoted = re.search(rf"\b{prop}=\"([^\"]*)\"", arglist)
                    if quoted and "enum" in spec:
                        self.assertIn(quoted.group(1), spec["enum"], f"{doc.name}: {tool}: {prop}={quoted.group(1)!r}")

    def test_contract_endpoint_filter_narrows_summary_and_exported_paths(self) -> None:
        sim = proxy_engine.run_live_simulation()
        self.assertTrue(sim["ok"])
        full = self._call("faultline_contract", {"action": "openapi"})
        self.assertEqual(set(full["paths"]), {"/api/v1/orders/{id}", "/api/v1/checkout"})

        narrowed = self._call("faultline_contract", {"export_openapi": True, "endpoint": "GET /api/v1/orders/{id}"})
        self.assertEqual(list(narrowed["paths"]), ["/api/v1/orders/{id}"])
        self.assertEqual(list(narrowed["paths"]["/api/v1/orders/{id}"]), ["get"])

        summary = self._call("faultline_contract", {"endpoint": "/orders"})
        self.assertTrue(summary["ok"])
        self.assertEqual(summary["contract_count"], 1)
        self.assertEqual([c["contract_key"] for c in summary["contracts"]], ["GET /api/v1/orders/{id}"])
        self.assertEqual(summary["drift_trace_count"], 1)
        self.assertEqual(summary["recent_drifts"][0]["path"], "/api/v1/orders/102")

    def test_query_traces_replayed_and_drifted_filters(self) -> None:
        base = proxy_engine.record_trace(
            "GET", "/api/v1/users/1", "http://127.0.0.1:9", {}, "", 200, {}, '{"id": 1, "n": 2}', 5.0
        )
        drifted = proxy_engine.record_trace(
            "GET", "/api/v1/users/2", "http://127.0.0.1:9", {}, "", 200, {}, '{"id": 2, "n": "two"}', 5.0
        )
        replayed = proxy_engine.record_trace(
            "GET", "/api/v1/users/1", "http://127.0.0.1:9", {}, "", 200, {}, '{"id": 1, "n": 3}', 5.0,
            replayed_from=base["trace_id"],
        )
        self.assertTrue(drifted["drifts"])
        self.assertEqual(replayed["replayed_from"], base["trace_id"])

        def ids(res: dict) -> list:
            return sorted(t["trace_id"] for t in res["traces"])

        self.assertEqual(ids(proxy_engine.query_traces(status_filter="replayed")), [replayed["trace_id"]])
        self.assertEqual(ids(proxy_engine.query_traces(replayed_only=True)), [replayed["trace_id"]])
        self.assertEqual(ids(proxy_engine.query_traces(status_filter="drifted")), [drifted["trace_id"]])
        self.assertEqual(ids(proxy_engine.query_traces(only_drifts=True)), [drifted["trace_id"]])
        self.assertEqual(len(ids(proxy_engine.query_traces(status_filter="all", method="*"))), 3)
        self.assertEqual(len(ids(proxy_engine.query_traces(method="POST"))), 0)

        # The same through the tool handler, both spellings.
        self.assertEqual(ids(self._call("faultline_traces", {"status_filter": "replayed"})), [replayed["trace_id"]])
        self.assertEqual(ids(self._call("faultline_traces", {"status_filter": "drifted"})), [drifted["trace_id"]])
        self.assertEqual(ids(self._call("faultline_traces", {"only_drifts": True})), [drifted["trace_id"]])
        self.assertEqual(ids(self._call("faultline_traces", {"only_drifts": True, "status_filter": "2xx"})), [drifted["trace_id"]])
        one = self._call("faultline_traces", {"trace_id": replayed["trace_id"], "status_filter": "5xx"})
        self.assertTrue(one["ok"])
        self.assertEqual(one["replayed_from"], base["trace_id"])

    def test_clear_recorder_keeps_chaos_rules_and_running_proxies(self) -> None:
        sim = proxy_engine.run_live_simulation()
        self.assertTrue(sim["ok"])
        rule = proxy_engine.add_chaos_rule(path_pattern="/keep", fault_type="status_code", status_code=429)
        info = proxy_engine.start_proxy(listen_port=0, target_url="http://127.0.0.1:9")
        self.assertTrue(info["ok"])
        before = proxy_engine.get_proxy_status()
        self.assertGreaterEqual(before["summary"]["total_traces"], 6)
        self.assertGreaterEqual(before["contract_count"], 2)

        res = self._call("faultline_proxy", {"action": "clear"})
        self.assertTrue(res["ok"])
        self.assertEqual(res["cleared"]["traces"], before["summary"]["total_traces"])
        self.assertEqual(res["cleared"]["contracts"], before["contract_count"])
        self.assertEqual(res["cleared"]["replays"], 1)
        self.assertEqual(res["kept"], ["chaos_rules", "active_proxies"])

        after = proxy_engine.get_proxy_status()
        self.assertEqual(after["summary"]["total_traces"], 0)
        self.assertEqual(after["contract_count"], 0)
        self.assertEqual(proxy_engine.get_db().execute("SELECT COUNT(*) FROM replays").fetchone()[0], 0)
        self.assertEqual(self._call("faultline_traces", {"trace_id": sim["failed_trace_id"]})["ok"], False)
        self.assertEqual([r["rule_id"] for r in proxy_engine.list_chaos_rules()["rules"]], [rule["rule"]["rule_id"]])
        self.assertEqual([p["listen_port"] for p in after["active_proxies"]], [info["listen_port"]])

        again = proxy_engine.clear_recorder()
        self.assertEqual(again["cleared"], {"traces": 0, "contracts": 0, "replays": 0})

    def test_pure_latency_chaos_rule_delays_then_forwards_upstream(self) -> None:
        hits = []

        class Upstream(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                return

            def do_GET(self):
                hits.append(self.path)
                body = json.dumps({"slow": True, "path": self.path}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        upstream = proxy_engine._ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        try:
            info = proxy_engine.start_proxy(
                listen_port=0, target_url=f"http://127.0.0.1:{upstream.server_address[1]}", data_dir=self.temp_dir
            )
            self.assertTrue(info["ok"])
            base = info["proxy_url"]
            slow = proxy_engine.add_chaos_rule(
                path_pattern="/slow", method="GET", fault_type="latency", latency_ms=300, data_dir=self.temp_dir
            )
            self.assertTrue(slow["ok"])
            rule_id = slow["rule"]["rule_id"]

            started = time.perf_counter()
            with urllib.request.urlopen(f"{base}/slow", timeout=10) as r:
                elapsed = time.perf_counter() - started
                self.assertEqual(r.status, 200)
                self.assertEqual(json.loads(r.read()), {"slow": True, "path": "/slow"})
                self.assertEqual(r.headers.get("X-Faultline-Chaos"), rule_id)
                trace_id = r.headers.get("X-Faultline-Trace-Id")
            self.assertGreaterEqual(elapsed, 0.28)
            self.assertEqual(hits, ["/slow"])

            trace = proxy_engine.get_trace(trace_id, data_dir=self.temp_dir)
            self.assertTrue(trace["ok"])
            self.assertEqual(trace["response_status"], 200)
            self.assertEqual(trace["chaos_rule_id"], rule_id)
            self.assertEqual(trace["replayed_from"], "")
            self.assertGreaterEqual(trace["latency_ms"], 280)
            rules = {r["rule_id"]: r for r in proxy_engine.list_chaos_rules(data_dir=self.temp_dir)["rules"]}
            self.assertEqual(rules[rule_id]["hits"], 1)

            # Control: latency_and_status delays and answers itself; the upstream is not called.
            blocked = proxy_engine.add_chaos_rule(
                path_pattern="/blocked", fault_type="latency_and_status", latency_ms=50, status_code=503,
                data_dir=self.temp_dir,
            )
            with self.assertRaises(urllib.error.HTTPError) as cm:
                urllib.request.urlopen(f"{base}/blocked", timeout=10)
            self.assertEqual(cm.exception.code, 503)
            self.assertEqual(cm.exception.headers.get("X-Faultline-Chaos"), blocked["rule"]["rule_id"])
            cm.exception.close()
            self.assertEqual(hits, ["/slow"])

            # The engine refuses a fault type the proxy does not implement.
            bad = proxy_engine.add_chaos_rule(path_pattern="/x", fault_type="explode", data_dir=self.temp_dir)
            self.assertFalse(bad["ok"])
            self.assertIn("fault_type", bad["error"])
        finally:
            upstream.shutdown()
            upstream.server_close()


if __name__ == "__main__":
    unittest.main()
