"""The 'storefront' for the demo film: sends real requests to a base URL (the Faultline proxy).

    python3 client.py http://127.0.0.1:53817 baseline   # healthy traffic (learns the contract)
    python3 client.py http://127.0.0.1:53817 coupon     # the failing FOUNDERS100 checkout
    python3 client.py http://127.0.0.1:53817 orders     # GET orders 101 and 102 (102 drifts)
    python3 client.py http://127.0.0.1:53817 webhook    # a Stripe-style webhook POST
    python3 client.py http://127.0.0.1:53817 all
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

# A fake credential, so the film can show Faultline redacting it. Not a real key format.
HEADERS = {"Content-Type": "application/json", "Authorization": "Bearer storefront-demo-token-9f2c-should-never-be-logged"}


def call(base: str, method: str, path: str, payload: dict | None = None) -> None:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(base.rstrip("/") + path, data=data, headers=HEADERS, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            status, body, trace = res.status, res.read().decode(), res.headers.get("X-Faultline-Trace-Id", "")
    except urllib.error.HTTPError as exc:
        status, body, trace = exc.code, exc.read().decode(errors="replace"), exc.headers.get("X-Faultline-Trace-Id", "")
    tag = f"  [{trace}]" if trace else ""
    print(f"{method:<4} {path:<28} -> {status}{tag}\n     {body[:160]}")


def main() -> None:
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    base, what = sys.argv[1], sys.argv[2]
    steps = {
        "baseline": [
            ("GET", "/api/v1/orders/101", None),
            ("POST", "/api/v1/checkout", {"subtotal_cents": 5000, "discount_cents": 0, "coupon": "WELCOME10"}),
            ("POST", "/api/v1/checkout", {"subtotal_cents": 12000, "coupon": ""}),
        ],
        "coupon": [("POST", "/api/v1/checkout", {"subtotal_cents": 5000, "coupon": "FOUNDERS100"})],
        "orders": [("GET", "/api/v1/orders/101", None), ("GET", "/api/v1/orders/102", None)],
        "webhook": [("POST", "/api/v1/webhooks/stripe", {"event_id": "evt_1NirvAnA", "type": "payment_intent.succeeded"})],
    }
    order = ["baseline", "coupon", "orders", "webhook"] if what == "all" else [what]
    for name in order:
        for method, path, payload in steps[name]:
            call(base, method, path, payload)


if __name__ == "__main__":
    main()
