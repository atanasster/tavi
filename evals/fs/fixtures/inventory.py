"""Stock keeping for the workshop's small shop."""

import logging

log = logging.getLogger("inventory")

LOW_STOCK_THRESHOLD = 5
WAREHOUSE = "north"


def load_items(rows):
    """Turn CSV rows into item records."""
    items = []
    for row in rows:
        items.append(
            {
                "sku": row["sku"],
                "name": row["name"],
                "count": int(row["count"]),
                "price": float(row["price"]),
            }
        )
    return items


def low_stock(items):
    """The items to reorder."""
    return [item for item in items if item["count"] < LOW_STOCK_THRESHOLD]


def total_value(items):
    """What the stock is worth."""
    return sum(item["count"] * item["price"] for item in items)


def sell(item, amount):
    """Take sold units off the shelf."""
    if amount > item["count"]:
        raise ValueError("not enough stock for " + item["sku"])
    item["count"] -= amount
    return item


def restock(item, amount):
    """Put delivered units on the shelf."""
    if amount <= 0:
        raise ValueError("a delivery has at least one unit")
    item["count"] += amount
    print("restocked", item["sku"])
    return item


def format_price(value, currency="USD"):
    """A price as the till prints it."""
    return f"{value:.2f} {currency}"


def report(items):
    """One line per item, and the reorder list."""
    lines = [f"{item['sku']}: {item['count']} x {format_price(item['price'])}" for item in items]
    reorder = ", ".join(item["sku"] for item in low_stock(items)) or "none"
    lines.append(f"reorder: {reorder}")
    return "\n".join(lines)
