"""Template expression resolution for {{...}} expressions in entity specs."""

from __future__ import annotations

import re
import random
from datetime import datetime, timedelta, timezone

_TEMPLATE_RE = re.compile(r"\{\{(.+?)\}\}")


def resolve_template(value, ctx):
    """Resolve all {{...}} expressions in a value. Handles strings, dicts, lists recursively."""
    if isinstance(value, str):
        return _resolve_string(value, ctx)
    if isinstance(value, list):
        return [resolve_template(v, ctx) for v in value]
    if isinstance(value, dict):
        return {k: resolve_template(v, ctx) for k, v in value.items()}
    return value


def _resolve_string(s: str, ctx):
    # If the entire string is a single expression, return raw value (preserving type)
    full_match = re.fullmatch(r"\{\{(.+?)\}\}", s)
    if full_match:
        return _evaluate_expression(full_match.group(1).strip(), ctx)

    # Otherwise, interpolate expressions into the string
    def replacer(match):
        val = _evaluate_expression(match.group(1).strip(), ctx)
        return str(val)

    return _TEMPLATE_RE.sub(replacer, s)


def _evaluate_expression(expr: str, ctx):
    if expr == "testRunId":
        return ctx.get("testRunId", ctx.get("test_run_id", ""))
    if expr == "index":
        return ctx.get("index", 0)
    if expr == "index1":
        return ctx.get("index", 0) + 1
    if expr == "now()":
        return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    # cycle([...])
    cycle_match = re.match(r"^cycle\(\[(.+)\]\)$", expr)
    if cycle_match:
        items = _parse_array_literal(cycle_match.group(1))
        index = ctx.get("index", 0)
        return items[index % len(items)]

    # pick([...])
    pick_match = re.match(r"^pick\(\[(.+)\]\)$", expr)
    if pick_match:
        items = _parse_array_literal(pick_match.group(1))
        return random.choice(items)

    # random.int(a,b)
    rand_int_match = re.match(r"^random\.int\((\d+),\s*(\d+)\)$", expr)
    if rand_int_match:
        min_val = int(rand_int_match.group(1))
        max_val = int(rand_int_match.group(2))
        return random.randint(min_val, max_val)

    # random.float(a,b)
    rand_float_match = re.match(r"^random\.float\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)\)$", expr)
    if rand_float_match:
        min_val = float(rand_float_match.group(1))
        max_val = float(rand_float_match.group(2))
        return random.uniform(min_val, max_val)

    # daysAgo(n)
    days_ago_match = re.match(r"^daysAgo\((\d+)\)$", expr)
    if days_ago_match:
        n = int(days_ago_match.group(1))
        dt = datetime.now(timezone.utc) - timedelta(days=n)
        return dt.isoformat().replace("+00:00", "Z")

    raise ValueError(f"Template error: unknown expression '{expr}'")


def _parse_array_literal(raw: str) -> list[str]:
    items = []
    for s in raw.split(","):
        s = s.strip()
        if (s.startswith("'") and s.endswith("'")) or (s.startswith('"') and s.endswith('"')):
            s = s[1:-1]
        items.append(s)
    return items
