"""Dashboard extension tests: the backend router must load the way Hermes loads it, and the
web-dashboard tab must be a well-formed plugin bundle."""

from __future__ import annotations

import importlib.util
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API_FILE = ROOT / "dashboard" / "plugin_api.py"
MANIFEST = ROOT / "dashboard" / "manifest.json"

try:  # the HTTP round-trip needs Hermes's own stack; the structural checks never skip
    import fastapi  # noqa: F401
    from fastapi.testclient import TestClient  # noqa: F401

    HAVE_FASTAPI_CLIENT = True
except Exception:  # pragma: no cover - depends on the environment
    HAVE_FASTAPI_CLIENT = False


def _load_api_as_hermes_does():
    """Hermes executes dashboard/plugin_api.py as a flat module with no parent package
    (hermes_cli.plugin_isolation.import_user_code and the plugin host's op_asgi both do this)."""
    name = "hermes_dashboard_plugin_faultline"
    sys.modules.pop(name, None)
    spec = importlib.util.spec_from_file_location(name, API_FILE)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    finally:
        sys.modules.pop(name, None)
    return module


class TestDashboardBackend(unittest.TestCase):
    def test_api_file_loads_as_flat_module(self) -> None:
        module = _load_api_as_hermes_does()
        self.assertTrue(hasattr(module, "router"), "plugin_api.py must export `router`")
        self.assertTrue(hasattr(module.proxy_engine, "get_proxy_status"))
        # Hermes adds the /api/plugins/<name> prefix itself; a prefix here would double it.
        self.assertEqual(getattr(module.router, "prefix", ""), "")

    def test_api_file_reuses_loaded_agent_half(self) -> None:
        """When the agent half is already imported (as hermes_plugins.faultline), the dashboard
        routes must share its proxy_engine module so in-memory state (active proxies, settings)
        is one and the same."""
        import types

        ns = types.ModuleType("hermes_plugins")
        ns.__path__ = []  # type: ignore[attr-defined]
        saved = {k: sys.modules.get(k) for k in ("hermes_plugins", "hermes_plugins.faultline")}
        sys.modules["hermes_plugins"] = ns
        spec = importlib.util.spec_from_file_location(
            "hermes_plugins.faultline", ROOT / "__init__.py", submodule_search_locations=[str(ROOT)]
        )
        pkg = importlib.util.module_from_spec(spec)
        sys.modules["hermes_plugins.faultline"] = pkg
        try:
            spec.loader.exec_module(pkg)
            module = _load_api_as_hermes_does()
            self.assertIs(module.proxy_engine, pkg.proxy_engine)
        finally:
            for key in [k for k in sys.modules if k == "hermes_plugins" or k.startswith("hermes_plugins.")]:
                sys.modules.pop(key, None)
            for key, value in saved.items():
                if value is not None:
                    sys.modules[key] = value

    @unittest.skipUnless(HAVE_FASTAPI_CLIENT, "fastapi test client not installed")
    def test_routes_answer_under_hermes_prefix(self) -> None:
        import shutil
        import tempfile

        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        module = _load_api_as_hermes_does()
        tmp = Path(tempfile.mkdtemp(prefix="faultline_dash_"))
        try:
            # Point the engine at a throwaway database for the duration of the test.
            engine = module.proxy_engine
            original_get_db = engine.get_db
            engine.get_db = lambda custom_data_dir=None: original_get_db(tmp)  # type: ignore[assignment]
            try:
                app = FastAPI()
                app.include_router(module.router, prefix="/api/plugins/faultline")
                client = TestClient(app)
                res = client.get("/api/plugins/faultline/status")
                self.assertEqual(res.status_code, 200, res.text)
                self.assertTrue(res.json()["ok"])
                res = client.get("/api/plugins/faultline/traces", params={"limit": 5})
                self.assertEqual(res.status_code, 200, res.text)
                self.assertEqual(client.get("/api/plugins/faultline/traces/flt-00000000").json()["ok"], False)
                res = client.post("/api/plugins/faultline/chaos", json={"path_pattern": "/x", "status_code": 503})
                self.assertEqual(res.status_code, 200, res.text)
                rule_id = res.json()["rule"]["rule_id"]
                self.assertTrue(client.delete(f"/api/plugins/faultline/chaos/{rule_id}").json()["removed"])
            finally:
                engine.get_db = original_get_db  # type: ignore[assignment]
                engine.close_cached_dbs()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class TestDashboardTab(unittest.TestCase):
    def test_manifest_declares_tab_and_entry(self) -> None:
        data = json.loads(MANIFEST.read_text(encoding="utf-8"))
        self.assertEqual(data["name"], "faultline")
        self.assertEqual(data["api"], "plugin_api.py")
        self.assertEqual(data["label"], "Faultline")
        self.assertEqual(data["tab"]["path"], "/faultline")
        entry = ROOT / "dashboard" / data["entry"]
        self.assertTrue(entry.is_file(), f"manifest entry {data['entry']} missing")

    def test_bundle_is_a_self_contained_iife(self) -> None:
        data = json.loads(MANIFEST.read_text(encoding="utf-8"))
        source = (ROOT / "dashboard" / data["entry"]).read_text(encoding="utf-8")
        self.assertIn('__HERMES_PLUGINS__', source)
        self.assertRegex(source, r'registry\.register\("faultline"|__HERMES_PLUGINS__\.register\("faultline"')
        # Catalog rules: nothing dynamic, nothing that bypasses the SDK fetcher.
        for forbidden in (r"\beval\(", r"new Function\(", r"\bimport\(", r"^\s*import\s", r"\bfetch\("):
            self.assertIsNone(re.search(forbidden, source, flags=re.MULTILINE), f"bundle must not use {forbidden}")
        self.assertIn('"/api/plugins/faultline"', source)


if __name__ == "__main__":
    unittest.main()
