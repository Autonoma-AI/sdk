"""Deterministic uniqueness helpers seeded from ``test_run_id``.

A scenario's ``data`` must have stable *keys* across runs, but its *values*
should be unique per run (unique emails, org slugs, ids) so two concurrent
runs never collide. These helpers derive that uniqueness deterministically
from ``(test_run_id, *inputs)``: the same inputs always produce the same
output within a run, so a scenario's ``up`` and a later ``down`` compute
identical values without storing them.
"""

from __future__ import annotations

import hashlib
import re

_TOKEN_LENGTH = 12
_SLUG_STRIP = re.compile(r"[^a-z0-9]+")


def _digest(test_run_id: str, parts: tuple[object, ...]) -> str:
    h = hashlib.sha256()
    h.update(test_run_id.encode("utf-8"))
    for part in parts:
        h.update(b" ")
        h.update(str(part).encode("utf-8"))
    return h.hexdigest()


def unique_token(test_run_id: str, *parts: object) -> str:
    """A short hex token, deterministic per ``(test_run_id, *parts)``."""
    return _digest(test_run_id, parts)[:_TOKEN_LENGTH]


def unique_id(test_run_id: str, prefix: str = "id", *parts: object) -> str:
    """A unique id like ``user_1a2b3c4d5e6f``, deterministic per inputs."""
    return f"{prefix}_{unique_token(test_run_id, prefix, *parts)}"


def unique_slug(test_run_id: str, base: str = "item", *parts: object) -> str:
    """A URL-safe slug like ``acme-1a2b3c4d5e6f``, deterministic per inputs."""
    normalized = _SLUG_STRIP.sub("-", str(base).lower()).strip("-") or "item"
    return f"{normalized}-{unique_token(test_run_id, base, *parts)}"


def unique_email(
    test_run_id: str, local: str = "user", domain: str = "example.com"
) -> str:
    """A unique email like ``user+1a2b3c4d5e6f@example.com``, deterministic per inputs."""
    return f"{local}+{unique_token(test_run_id, local, domain)}@{domain}"
