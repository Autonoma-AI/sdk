"""Request routing for discover/up/down protocol actions."""

import json
import uuid

from .hmac_util import verify_signature
from .refs import sign_refs, verify_refs
from .errors import AutonomaError, invalid_signature, invalid_body, unknown_action, production_blocked, invalid_refs_token, same_secrets

PROTOCOL_VERSION = "1.0"


def _build_sdk_meta(config) -> dict:
    return {
        "version": PROTOCOL_VERSION,
        "sdk": {
            "language": "python",
            "orm": getattr(config.adapter, "name", None) or getattr(config, "sdk_orm", "unknown"),
            "server": getattr(config, "sdk_server", "unknown"),
        },
    }


async def handle_request(config, req) -> dict:
    """Handle an incoming Autonoma protocol request."""
    try:
        if config.shared_secret == config.signing_secret:
            raise same_secrets()

        signature = req.headers.get("x-signature") or req.headers.get("X-Signature") or ""

        if not verify_signature(req.body, signature, config.shared_secret):
            raise invalid_signature()

        try:
            body = json.loads(req.body)
        except (json.JSONDecodeError, ValueError):
            raise invalid_body("invalid JSON")

        action = body.get("action")
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


def _handle_discover(config) -> dict:
    schema = config.adapter.get_schema()
    return {"status": 200, "body": {**_build_sdk_meta(config), "schema": schema}}


async def _handle_up(config, body) -> dict:
    create = body.get("create")
    if not create:
        raise invalid_body('missing "create" in request body')

    test_run_id = body.get("testRunId", str(uuid.uuid4()))
    refs = {}

    refs_token = sign_refs(
        {"refs": refs, "testRunId": test_run_id, "environment": ""},
        config.signing_secret,
    )

    auth = {"token": ""}
    if config.auth:
        auth = config.auth({})

    return {"status": 200, "body": {**_build_sdk_meta(config), "auth": auth, "refs": refs, "refsToken": refs_token}}


async def _handle_down(config, body) -> dict:
    refs_token = body.get("refsToken")
    if not refs_token:
        raise invalid_body("missing refsToken")

    try:
        payload = verify_refs(refs_token, config.signing_secret)
    except Exception as e:
        raise invalid_refs_token(str(e))

    await config.adapter.teardown(payload["testRunId"], payload.get("refs"))

    return {"status": 200, "body": {**_build_sdk_meta(config), "ok": True}}
