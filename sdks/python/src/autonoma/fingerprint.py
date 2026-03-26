"""Deterministic SHA256-based fingerprinting of scenario definitions."""

import hashlib
import json


def fingerprint(value) -> str:
    """Compute a 16-char hex fingerprint of any JSON-serializable value."""
    normalized = _sort_keys(value)
    json_str = json.dumps(normalized, separators=(",", ":"))
    return hashlib.sha256(json_str.encode()).hexdigest()[:16]


def _sort_keys(obj):
    """Recursively sort object keys for deterministic serialization."""
    if isinstance(obj, dict):
        return {k: _sort_keys(v) for k, v in sorted(obj.items())}
    if isinstance(obj, list):
        return [_sort_keys(v) for v in obj]
    return obj
