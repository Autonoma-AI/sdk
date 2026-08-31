"""Request routing for discover/up/down protocol actions (Scenario v2).

``discover`` lists the registered scenarios; ``up`` looks a scenario up by
name, runs its free-form ``up``, signs a teardown token carrying the scenario
name, and responds; ``down`` recovers the scenario name from the verified
token and routes to that scenario's ``down``. There is no create-graph
interpreter and no factory-derived discover schema.
"""

from __future__ import annotations

import inspect
import json
import uuid
from typing import Any

from autonoma.errors import (
    AutonomaError,
    invalid_body,
    invalid_teardown_token,
    invalid_signature,
    same_secrets,
    unknown_action,
    unknown_environment,
)
from autonoma.hmac_util import verify_signature
from autonoma.refs import sign_refs, verify_refs
from autonoma.types import (
    HandlerConfig,
    HandlerRequest,
    HandlerResponse,
    ScenarioDefinition,
    ScenarioDownContext,
    ScenarioUpContext,
    ScenarioUpResult,
)

_DEFAULT_EXPIRES_IN_SECONDS = 3600


def _load_protocol_version() -> str:
    try:
        from pathlib import Path

        return (
            (Path(__file__).resolve().parents[4] / "protocol" / "version.txt")
            .read_text()
            .strip()
        )
    except (OSError, IndexError):
        return "2.0"


PROTOCOL_VERSION = _load_protocol_version()


def _build_sdk_meta(config: HandlerConfig) -> dict[str, Any]:
    sdk = config.sdk or {}
    return {
        "version": PROTOCOL_VERSION,
        "sdk": {
            "language": "python",
            "orm": sdk.get("orm", "unknown"),
            "server": sdk.get("server", "unknown"),
        },
    }


async def handle_request(config: HandlerConfig, req: HandlerRequest) -> HandlerResponse:
    """Handle an incoming Autonoma protocol request."""
    try:
        if config.shared_secret == config.signing_secret:
            raise same_secrets()

        signature: str = (
            req.headers.get("x-signature") or req.headers.get("X-Signature") or ""
        )
        if not verify_signature(req.body, signature, config.shared_secret):
            raise invalid_signature()

        try:
            body: dict[str, Any] = json.loads(req.body)
        except (json.JSONDecodeError, ValueError):
            raise invalid_body("invalid JSON")

        action = body.get("action")
        if not action:
            raise invalid_body(
                "missing action. expected one of 'discover', 'up' or 'down'"
            )

        if action == "discover":
            return await _handle_discover(config)
        if action == "up":
            return await _handle_up(config, body)
        if action == "down":
            return await _handle_down(config, body)
        raise unknown_action(action)

    except AutonomaError as e:
        return HandlerResponse(
            status=e.status, body={"error": e.message, "code": e.code}
        )
    except Exception as e:
        return HandlerResponse(
            status=500, body={"error": str(e), "code": "INTERNAL_ERROR"}
        )


# ---------------------------------------------------------------------------
# discover
# ---------------------------------------------------------------------------


async def _handle_discover(config: HandlerConfig) -> HandlerResponse:
    scenarios = [
        {"name": s.name, "description": s.description} for s in config.scenarios
    ]
    return HandlerResponse(
        status=200,
        body={**_build_sdk_meta(config), "scenarios": scenarios},
    )


# ---------------------------------------------------------------------------
# up
# ---------------------------------------------------------------------------


async def _handle_up(config: HandlerConfig, body: dict[str, Any]) -> HandlerResponse:
    name = _read_scenario_name(body)
    if name is None:
        raise invalid_body('missing "scenario.name" in request body')

    scenario = _find_scenario(config, name)
    if scenario is None:
        raise unknown_environment(name)

    test_run_id: str = body.get("testRunId") or str(uuid.uuid4())

    result = scenario.up(ScenarioUpContext(test_run_id=test_run_id))
    if inspect.isawaitable(result):
        result = await result

    auth, teardown = _unpack_up_result(result)

    teardown_token = sign_refs(
        {"refs": teardown or {}, "testRunId": test_run_id, "environment": name},
        config.signing_secret,
    )

    expires_in_seconds = (
        config.expires_in_seconds
        if config.expires_in_seconds is not None
        else _DEFAULT_EXPIRES_IN_SECONDS
    )

    response_body: dict[str, Any] = {**_build_sdk_meta(config)}
    if auth is not None:
        response_body["auth"] = auth
    response_body["teardownToken"] = teardown_token
    response_body["expiresInSeconds"] = expires_in_seconds

    return HandlerResponse(status=200, body=response_body)


def _unpack_up_result(
    result: Any,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Accept either a ``ScenarioUpResult`` or a plain dict from a scenario's ``up``."""
    if result is None:
        return None, None
    if isinstance(result, ScenarioUpResult):
        return result.auth, result.teardown
    if isinstance(result, dict):
        return result.get("auth"), result.get("teardown")
    raise AutonomaError(
        "Scenario up() must return a dict or ScenarioUpResult with optional "
        "auth/teardown keys",
        "INTERNAL_ERROR",
        500,
    )


# ---------------------------------------------------------------------------
# down
# ---------------------------------------------------------------------------


async def _handle_down(config: HandlerConfig, body: dict[str, Any]) -> HandlerResponse:
    teardown_token = body.get("teardownToken")
    if not teardown_token:
        raise invalid_body("missing teardownToken")

    try:
        payload = verify_refs(teardown_token, config.signing_secret)
    except Exception as e:
        raise invalid_teardown_token(str(e))

    teardown: dict[str, Any] = payload.get("refs") or {}
    test_run_id: str = payload.get("testRunId", "")
    # The verified token is authoritative for routing; any scenario name on
    # the request body is ignored.
    name = payload.get("environment") or ""

    scenario = _find_scenario(config, name) if name else None
    if scenario is not None and scenario.down is not None:
        result = scenario.down(
            ScenarioDownContext(name=name, teardown=teardown, test_run_id=test_run_id)
        )
        if inspect.isawaitable(result):
            await result

    return HandlerResponse(status=200, body={**_build_sdk_meta(config), "ok": True})


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _find_scenario(config: HandlerConfig, name: str) -> ScenarioDefinition | None:
    for scenario in config.scenarios:
        if scenario.name == name:
            return scenario
    return None


def _read_scenario_name(body: dict[str, Any]) -> str | None:
    scenario = body.get("scenario")
    if isinstance(scenario, dict):
        name = scenario.get("name")
        if isinstance(name, str):
            return name
    return None
