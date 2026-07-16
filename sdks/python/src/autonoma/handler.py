"""Request routing for discover/up/down protocol actions.

Factory-driven design: every model in ``body.create`` must have a
registered factory. The SDK uses the factory's Pydantic ``input_model``
both to validate inputs and to build the ``discover`` schema. Ordering
for ``up`` and ``down`` comes from the create payload's
``_alias`` / ``_ref`` graph (see :mod:`autonoma.payload_topo`); there is
no SQL introspection.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import re
import uuid
from typing import Any

from autonoma.errors import (
    AutonomaError,
    invalid_body,
    invalid_refs_token,
    invalid_signature,
    same_secrets,
    unknown_action,
)
from autonoma.hmac_util import verify_signature
from autonoma.payload_topo import compute_teardown_order, resolve_payload_tree
from autonoma.refs import sign_refs, verify_refs
from autonoma.schema import build_schema_from_factories, schema_to_wire
from autonoma.types import (
    AuthContext,
    FactoryContext,
    HandlerConfig,
    HandlerRequest,
    HandlerResponse,
    HookContext,
)

_TOKEN_RE = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")
_CYCLE_RE = re.compile(r"^cycle\((.*)\)$")


def _resolve_tokens(value: Any, test_run_id: str, index: int) -> Any:
    """Substitute built-in tokens: ``{{testRunId}}``, ``{{index}}``, ``{{cycle(a,b,c)}}``.

    The dashboard expands recipe variables before sending the payload, so
    the SDK normally sees no placeholders here. This is defense-in-depth
    for tokens that slip through — anything else raises
    ``UNRESOLVED_TOKEN`` rather than landing literally in the database.
    """
    if isinstance(value, str):

        def replace(match: re.Match) -> str:
            token = match.group(1).strip()
            if token == "testRunId":
                return test_run_id
            if token == "index":
                return str(index)
            cycle = _CYCLE_RE.match(token)
            if cycle:
                parts = [
                    p.strip().strip('"').strip("'") for p in cycle.group(1).split(",")
                ]
                return parts[index % len(parts)] if parts else ""
            raise AutonomaError(
                f"Unresolved token: {{{{{token}}}}}",
                "UNRESOLVED_TOKEN",
                400,
            )

        return _TOKEN_RE.sub(replace, value)
    if isinstance(value, list):
        return [_resolve_tokens(v, test_run_id, index) for v in value]
    if isinstance(value, dict):
        return {k: _resolve_tokens(v, test_run_id, index) for k, v in value.items()}
    return value


def _load_protocol_version() -> str:
    try:
        from pathlib import Path

        return (
            (Path(__file__).resolve().parents[4] / "protocol" / "version.txt")
            .read_text()
            .strip()
        )
    except (OSError, IndexError):
        return "1.0"


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

        action: str | None = body.get("action")
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
    schema = build_schema_from_factories(config.factories or {}, config.scope_field)
    return HandlerResponse(
        status=200,
        body={**_build_sdk_meta(config), "schema": schema_to_wire(schema)},
    )


# ---------------------------------------------------------------------------
# up
# ---------------------------------------------------------------------------


async def _handle_up(config: HandlerConfig, body: dict[str, Any]) -> HandlerResponse:
    create = body.get("create")
    if not create:
        raise invalid_body('missing "create" in request body')

    test_run_id: str = body.get("testRunId", str(uuid.uuid4()))

    factories = config.factories or {}
    if not factories:
        raise invalid_body(
            "no factories registered — every model in `create` must have a factory."
        )

    tree = resolve_payload_tree(create)

    refs: dict[str, list[dict[str, Any]]] = {}
    id_map: dict[str, Any] = {}

    # Track per-model run index for {{index}} / {{cycle()}} substitution.
    model_index: dict[str, int] = {}

    for op in tree.ops:
        model = op.model
        factory = factories.get(model)
        if factory is None:
            raise invalid_body(
                f'no factory registered for model "{model}". '
                "Register one with `define_factory(...)` and add it to HandlerConfig.factories."
            )

        idx = model_index.get(model, 0)
        model_index[model] = idx + 1

        # Substitute built-in tokens then swap temp ids for real ids.
        resolved = _resolve_tokens(op.fields, test_run_id, idx)
        resolved = _swap_temp_ids(resolved, id_map)

        # Validate through the factory's input model and call create.
        call_input = factory.input_model.model_validate(resolved)
        ctx = FactoryContext(
            refs=refs, scenario_name=test_run_id, test_run_id=test_run_id
        )
        record = factory.create(call_input, ctx)
        if inspect.isawaitable(record):
            record = await record

        # Normalise Pydantic returns to dicts so downstream lookups are uniform.
        if hasattr(record, "model_dump") and not isinstance(record, dict):
            record = record.model_dump()
        if not isinstance(record, dict) or record.get("id") is None:
            raise AutonomaError(
                f'Factory for "{model}" must return a record dict with "id"',
                "FACTORY_MISSING_PK",
                500,
            )

        refs.setdefault(model, []).append(record)
        id_map[op.temp_id] = record["id"]

    # auth callback gets the first User (case-insensitive on model name).
    auth_user = _find_first_user(refs)
    scope_value = _detect_scope_value(refs, config.scope_field) or test_run_id
    auth_context = AuthContext(scope_value=scope_value, refs=refs)
    auth = config.auth(auth_user, auth_context)
    if inspect.isawaitable(auth):
        auth = await auth

    if config.after_up is not None:
        hook_ctx = HookContext(scenario_name=scope_value, refs=refs)
        result = config.after_up(hook_ctx, auth)
        if asyncio.iscoroutine(result):
            auth = await result
        else:
            auth = result

    refs_token = sign_refs(
        {
            "refs": refs,
            "testRunId": scope_value,
            "environment": "",
            # Captured for ordered teardown without re-parsing the create
            # payload. Older tokens that omit this fall back to refs-key
            # reversal.
            "aliasDependencies": tree.alias_dependencies,
            "aliasOwnerModel": tree.alias_owner_model,
        },
        config.signing_secret,
    )

    return HandlerResponse(
        status=200,
        body={
            **_build_sdk_meta(config),
            "auth": auth,
            "refs": refs,
            "refsToken": refs_token,
        },
    )


def _swap_temp_ids(value: Any, id_map: dict[str, Any]) -> Any:
    """Replace any ``__temp_*`` placeholder string with its real id."""
    if isinstance(value, str) and value.startswith("__temp_"):
        return id_map.get(value, value)
    if isinstance(value, dict):
        return {k: _swap_temp_ids(v, id_map) for k, v in value.items()}
    if isinstance(value, list):
        return [_swap_temp_ids(v, id_map) for v in value]
    return value


# ---------------------------------------------------------------------------
# down
# ---------------------------------------------------------------------------


async def _handle_down(config: HandlerConfig, body: dict[str, Any]) -> HandlerResponse:
    refs_token = body.get("refsToken")
    if not refs_token:
        raise invalid_body("missing refsToken")

    try:
        payload = verify_refs(refs_token, config.signing_secret)
    except Exception as e:
        raise invalid_refs_token(str(e))

    refs: dict[str, list[dict[str, Any]]] = payload.get("refs") or {}
    test_run_id: str = payload.get("testRunId", "")
    alias_deps = payload.get("aliasDependencies") or {}
    alias_owner_model = payload.get("aliasOwnerModel") or {}

    if config.before_down is not None:
        hook_ctx = HookContext(scenario_name=test_run_id, refs=refs)
        result = config.before_down(hook_ctx)
        if asyncio.iscoroutine(result):
            await result

    factories = config.factories or {}
    teardown_order = compute_teardown_order(refs, alias_deps, alias_owner_model)

    for model in teardown_order:
        factory = factories.get(model)
        if factory is None or factory.teardown is None:
            # No teardown means the host has decided not to delete this
            # model; skip. The SDK has no SQL fallback.
            continue
        records = refs.get(model, [])
        ctx = FactoryContext(
            refs=refs, scenario_name=test_run_id, test_run_id=test_run_id
        )
        for record in reversed(records):
            td_input: Any = record
            if factory.ref_model is not None:
                td_input = factory.ref_model.model_validate(record)
            result = factory.teardown(td_input, ctx)
            if inspect.isawaitable(result):
                await result

    return HandlerResponse(status=200, body={**_build_sdk_meta(config), "ok": True})


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _find_first_user(refs: dict[str, list[dict[str, Any]]]) -> dict[str, Any] | None:
    for model, records in refs.items():
        normalised = model.lower()
        if (normalised == "user" or normalised == "users") and records:
            return records[0]
    return None


def _detect_scope_value(
    refs: dict[str, list[dict[str, Any]]], scope_field: str
) -> str | None:
    """Find the first record value whose key matches ``scope_field`` modulo underscores/case."""
    target = scope_field.replace("_", "").lower()
    for records in refs.values():
        for record in records:
            for key, value in record.items():
                if key.replace("_", "").lower() == target and isinstance(value, str):
                    return value
    return None
