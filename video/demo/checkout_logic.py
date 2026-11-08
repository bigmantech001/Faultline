"""Business logic for the demo checkout service (hot-reloaded by checkout_service.py)."""

PLATFORM_FEE_CENTS = 150

ORDERS = {
    "101": {"order_id": "ord_101", "customer_tier": "enterprise", "total_cents": 12500, "currency": "USD", "status": "confirmed"},
    # Legacy row imported from the old billing system: total stored as text, no currency column.
    "102": {"order_id": "ord_102", "customer_tier": "pro", "total_cents": "twelve-thousand-five-hundred", "status": "pending_review"},
}

COUPONS = {
    "WELCOME10": 0.10,
    "FOUNDERS100": 1.00,
}


def calculate_fee_ratio(subtotal_cents: int, net_payable_cents: int) -> float:
    """Platform fee as a share of what the customer actually pays."""
    return round(PLATFORM_FEE_CENTS / net_payable_cents, 4)


def checkout(data: dict) -> dict:
    subtotal = int(data.get("subtotal_cents", 0))
    coupon = str(data.get("coupon") or "").upper()
    discount = int(round(subtotal * COUPONS.get(coupon, 0.0)))
    net_payable = subtotal - discount
    return {
        "checkout_id": "chk_9001",
        "coupon": coupon or None,
        "subtotal_cents": subtotal,
        "discount_cents": discount,
        "net_payable_cents": net_payable,
        "fee_ratio": calculate_fee_ratio(subtotal, net_payable),
        "status": "settled",
    }


def get_order(order_id: str) -> dict:
    return dict(ORDERS[order_id])
