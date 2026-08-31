"""Dry-run a scenario through the in-process handler.

``check_scenario`` lets a caller validate a scenario without standing up a
real HTTP server: it builds a :class:`HandlerConfig` with the single
scenario, invokes ``handle_request`` for the ``up`` and ``down`` phases,
and reports any errors.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any

from autonoma.handler import HandlerRequest, handle_request
from autonoma.hmac_util import sign_body
from autonoma.types import HandlerConfig, ScenarioDefinition


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
    scenario: ScenarioDefinition,
    options: dict[str, Any] | None = None,
) -> CheckResult:
    """Run a full ``up -> down`` cycle and return structured errors."""
    options = options or {}
    shared_secret = options.get("sharedSecret", "autonoma-check-shared")
    signing_secret = options.get("signingSecret", "autonoma-check-signing")
    test_run_id = options.get("testRunId", f"check-{scenario.name}")

    config = HandlerConfig(
        shared_secret=shared_secret,
        signing_secret=signing_secret,
        scenarios=[scenario],
    )

    up_body = json.dumps(
        {
            "action": "up",
            "scenario": {"name": scenario.name},
            "testRunId": test_run_id,
        }
    )
    up_req = HandlerRequest(
        body=up_body, headers={"x-signature": sign_body(up_body, shared_secret)}
    )

    t0 = time.monotonic()
    up_res = await handle_request(config, up_req)
    up_ms = round((time.monotonic() - t0) * 1000)

    if up_res.status != 200:
        message = up_res.body.get("error", "Unknown error")
        return CheckResult(
            valid=False,
            phase="up",
            errors=[CheckError(phase="up", message=message)],
            timing={"upMs": up_ms, "downMs": 0},
        )

    teardown_token = up_res.body.get("teardownToken", "")
    down_body = json.dumps(
        {
            "action": "down",
            "teardownToken": teardown_token,
        }
    )
    down_req = HandlerRequest(
        body=down_body, headers={"x-signature": sign_body(down_body, shared_secret)}
    )

    t1 = time.monotonic()
    down_res = await handle_request(config, down_req)
    down_ms = round((time.monotonic() - t1) * 1000)

    if down_res.status != 200:
        message = down_res.body.get("error", "Unknown error")
        return CheckResult(
            valid=False,
            phase="down",
            errors=[CheckError(phase="down", message=message)],
            timing={"upMs": up_ms, "downMs": down_ms},
        )

    return CheckResult(
        valid=True,
        phase="ok",
        errors=[],
        timing={"upMs": up_ms, "downMs": down_ms},
    )
