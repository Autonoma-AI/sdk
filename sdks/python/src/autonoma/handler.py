"""Request routing for discover/up/down protocol actions."""

from __future__ import annotations

import json
import uuid
from typing import Any

from .hmac_util import verify_signature
from .refs import sign_refs, verify_refs
from .errors import AutonomaError, invalid_signature, invalid_body, unknown_action, production_blocked, invalid_refs_token, same_secrets
from .types import HandlerConfig, HandlerRequest

PROTOCOL_VERSION = "1.0"


def _build_sdk_meta(config: HandlerConfig) -> dict[str, Any]:
    return {
        "version": PROTOCOL_VERSION,
        "sdk": {
            "language": "python",
            "orm": getattr(config.adapter, "name", None) or getattr(config, "sdk_orm", "unknown"),
            "server": getattr(config, "sdk_server", "unknown"),
        },
    }


async def handle_request(config: HandlerConfig, req: HandlerRequest) -> dict[str, Any]:
    """Handle an incoming Autonoma protocol request."""
    try:
        if config.shared_secret == config.signing_secret:
            raise same_secrets()

        signature: str = req.headers.get("x-signature") or req.headers.get("X-Signature") or ""

        if not verify_signature(req.body, signature, config.shared_secret):
            raise invalid_signature()

        try:
            body: dict[str, Any] = json.loads(req.body)
        except (json.JSONDecodeError, ValueError):
            raise invalid_body("invalid JSON")

        action: str | None = body.get("action")
        if not action:
            raise invalid_body("missing action")

        if action == "discover":
            return _handle_discover(config)
        elif action == "up":
            return await _handle_up(config, body)
        elif action == "down":
            return await _handle_down(config, body)
        else:
            raise unknown_action(action)

    except AutonomaError as e:
        return {"status": e.status, "body": {"error": e.message, "code": e.code}}
    except Exception as e:
        return {"status": 500, "body": {"error": str(e), "code": "INTERNAL_ERROR"}}


def _handle_discover(config: HandlerConfig) -> dict[str, Any]:
    schema: dict[str, Any] = config.adapter.get_schema()
    return {"status": 200, "body": {**_build_sdk_meta(config), "schema": schema}}


async def _handle_up(config: HandlerConfig, body: dict[str, Any]) -> dict[str, Any]:
    create: dict[str, Any] | None = body.get("create")
    if not create:
        raise invalid_body('missing "create" in request body')

    test_run_id: str = body.get("testRunId", str(uuid.uuid4()))
    refs: dict[str, list[dict[str, Any]]] = {}

    refs_token: str = sign_refs(
        {"refs": refs, "testRunId": test_run_id, "environment": ""},
        config.signing_secret,
    )

    auth: dict[str, str] = {"token": ""}
    if config.auth:
        auth = config.auth({})

    return {"status": 200, "body": {**_build_sdk_meta(config), "auth": auth, "refs": refs, "refsToken": refs_token}}


async def _handle_down(config: HandlerConfig, body: dict[str, Any]) -> dict[str, Any]:
    refs_token: str | None = body.get("refsToken")
    if not refs_token:
        raise invalid_body("missing refsToken")

    try:
        payload: dict[str, Any] = verify_refs(refs_token, config.signing_secret)
    except Exception as e:
        raise invalid_refs_token(str(e))

    await config.adapter.teardown(payload["testRunId"], payload.get("refs"))

    return {"status": 200, "body": {**_build_sdk_meta(config), "ok": True}}
