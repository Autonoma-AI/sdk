"""Dry-run a scenario against a real database."""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from typing import Any

from .types import SQLExecutor, HandlerConfig
from .handler import handle_request, HandlerRequest
from .hmac_util import sign_body


@dataclass
class CheckError:
    phase: str
    message: str
    fix: str = ""


@dataclass
class CheckResult:
    valid: bool
    phase: str
    errors: list[CheckError] = field(default_factory=list)
    timing: dict[str, int] | None = None


async def check_scenario(
    executor: SQLExecutor,
    scenario: dict[str, Any],
    options: dict[str, Any] | None = None,
) -> CheckResult:
    """Run a full up→down cycle and return structured errors."""
    options = options or {}
    shared_secret = options.get("sharedSecret", "autonoma-check-shared")
    signing_secret = options.get("signingSecret", "autonoma-check-signing")

    config = HandlerConfig(
        executor=executor,
        scope_field=options.get("scopeField", "organizationId"),
        dialect=options.get("dialect", "postgres"),
        db_schema=options.get("dbSchema"),
        table_name_map=options.get("tableNameMap"),
        shared_secret=shared_secret,
        signing_secret=signing_secret,
        auth=options.get("auth", lambda _: {"token": "check-token"}),
    )

    # Up
    up_body = json.dumps({"action": "up", "create": scenario.get("create", {})})
    up_req = HandlerRequest(
        body=up_body,
        headers={"x-signature": sign_body(up_body, shared_secret)},
    )

    t0 = time.monotonic()
    up_res = await handle_request(config, up_req)
    up_ms = round((time.monotonic() - t0) * 1000)

    if up_res.status != 200:
        error_msg = up_res.body.get("error", "Unknown error")
        return CheckResult(
            valid=False,
            phase="up",
            errors=[CheckError(phase="up", message=error_msg, fix=_suggest_fix(error_msg))],
            timing={"upMs": up_ms, "downMs": 0},
        )

    # Down
    refs_token = up_res.body.get("refsToken", "")
    down_body = json.dumps({"action": "down", "refsToken": refs_token})
    down_req = HandlerRequest(
        body=down_body,
        headers={"x-signature": sign_body(down_body, shared_secret)},
    )

    t1 = time.monotonic()
    down_res = await handle_request(config, down_req)
    down_ms = round((time.monotonic() - t1) * 1000)

    if down_res.status != 200:
        error_msg = down_res.body.get("error", "Unknown error")
        return CheckResult(
            valid=False,
            phase="down",
            errors=[CheckError(phase="down", message=error_msg)],
            timing={"upMs": up_ms, "downMs": down_ms},
        )

    return CheckResult(valid=True, phase="ok", errors=[], timing={"upMs": up_ms, "downMs": down_ms})


def _suggest_fix(error_msg: str) -> str:
    if "unique constraint" in error_msg.lower() or "Unique constraint failed" in error_msg:
        match = re.search(r'fields: \(`(.+?)`\)', error_msg) or re.search(r'constraint "(.+?)"', error_msg)
        if match:
            return f"Unique constraint on ({match.group(1)}). Add {{{{testRunId}}}} or {{{{index}}}} to make values unique."
        return "Unique constraint violation. Make field values unique across instances."
    if "foreign key" in error_msg.lower():
        return "A referenced record does not exist. Check that parent entities are nested correctly."
    if "null value in column" in error_msg or "must not be null" in error_msg:
        return "A required field is null. Add it to the node with a value."
    return ""
