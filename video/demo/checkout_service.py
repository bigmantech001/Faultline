"""Checkout microservice used in the Faultline demo film.

A deliberately small, real HTTP service. Its business logic lives in ``checkout_logic.py`` next to
this file and is hot-reloaded whenever that file changes, so an agent can fix the bug by editing the
file; no restart needed. Run: ``python3 checkout_service.py --port 8000``.
"""

from __future__ import annotations

import argparse
import http.server
import importlib
import importlib.util
import json
import os
import socketserver
import sys
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOGIC_PATH = HERE / "checkout_logic.py"

_logic = None
_logic_mtime = 0.0


def logic():
    """Import checkout_logic, reloading it when the file on disk changed."""
    global _logic, _logic_mtime
    mtime = LOGIC_PATH.stat().st_mtime
    if _logic is None or mtime != _logic_mtime:
        spec = importlib.util.spec_from_file_location("checkout_logic", LOGIC_PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _logic, _logic_mtime = module, mtime
    return _logic


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "checkout/1.4"

    def log_message(self, fmt, *args):  # quiet; Faultline is the log
        return

    def _json(self, status: int, payload: dict) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        try:
            if self.path.startswith("/api/v1/orders/"):
                order_id = self.path.rsplit("/", 1)[-1]
                self._json(200, logic().get_order(order_id))
            elif self.path == "/health":
                self._json(200, {"ok": True})
            else:
                self._json(404, {"error": "not_found", "path": self.path})
        except KeyError:
            self._json(404, {"error": "order_not_found"})
        except Exception as exc:  # noqa: BLE001 - surfaced as a 500 like a real service would
            self._json(500, {"error": type(exc).__name__, "detail": str(exc), "endpoint": self.path})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode("utf-8") if length else "{}"
        try:
            data = json.loads(body or "{}")
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid_json"})
            return
        try:
            if self.path == "/api/v1/checkout":
                self._json(200, logic().checkout(data))
            elif self.path == "/api/v1/webhooks/stripe":
                self._json(200, {"received": True, "event_id": data.get("event_id", "evt_1")})
            else:
                self._json(404, {"error": "not_found", "path": self.path})
        except Exception as exc:  # noqa: BLE001
            tb = traceback.extract_tb(sys.exc_info()[2])[-1]
            self._json(
                500,
                {
                    "error": type(exc).__name__,
                    "detail": f"{exc} in {tb.name}() at checkout_logic.py:{tb.lineno}",
                    "endpoint": self.path,
                },
            )


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> None:
    parser = argparse.ArgumentParser(description="Demo checkout service (hot-reloads checkout_logic.py)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    logic()  # fail fast on a syntax error in the logic file
    with Server((args.host, args.port), Handler) as srv:
        print(f"checkout service listening on http://{args.host}:{args.port} (logic: {LOGIC_PATH.name})", flush=True)
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
