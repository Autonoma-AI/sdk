"""Request routing for discover/up/down protocol actions."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

from .hmac_util import verify_signature
from .refs import sign_refs, verify_refs
from .errors import AutonomaError, invalid_signature, invalid_body, unknown_action, production_blocked, invalid_refs_token, same_secrets
from .types import HandlerConfig, HandlerRequest, HandlerResponse, IntrospectionResult
from .dialect import get_dialect
from .introspect import introspect_database
from .tree import resolve_tree
from .create import create_entities, update_entity
from .teardown import teardown

from pathlib import Path as _Path

PROTOCOL_VERSION = (
    _Path(__file__).resolve().parents[4] / "protocol" / "version.txt"
).read_text().strip()

async def _get_introspection(config: HandlerConfig) -> IntrospectionResult:
    cached = getattr(config, "_introspection_cache", None)
    if cached is not None:
        return cached

    dialect = get_dialect(config.dialect)
    result = await introspect_database(
        config.executor,
        dialect,
        scope_field=config.scope_field,
        schema=config.db_schema,
        table_name_map=config.table_name_map,
        exclude_tables=config.exclude_tables,
    )
    config._introspection_cache = result  # type: ignore[attr-defined]
    return result


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

        if not config.allow_production:
            import os
            if os.environ.get("PYTHON_ENV") == "production" or os.environ.get("ENV") == "production":
                raise production_blocked()

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
            return await _handle_discover(config)
        elif action == "up":
            return await _handle_up(config, body)
        elif action == "down":
            return await _handle_down(config, body)
        else:
            raise unknown_action(action)

    except AutonomaError as e:
        return HandlerResponse(status=e.status, body={"error": e.message, "code": e.code})
    except Exception as e:
        return HandlerResponse(status=500, body={"error": str(e), "code": "INTERNAL_ERROR"})


async def _handle_discover(config: HandlerConfig) -> HandlerResponse:
    introspection = await _get_introspection(config)
    schema = introspection.schema
    # Serialize to dict
    schema_dict = {
        "models": [
            {"name": m.name, "tableName": m.table_name, "fields": [
                {"name": f.name, "type": f.type, "isRequired": f.is_required, "isId": f.is_id, "hasDefault": f.has_default}
                for f in m.fields
            ]}
            for m in schema.models
        ],
        "edges": [
            {"from": e.from_model, "to": e.to_model, "localField": e.local_field,
             "foreignField": e.foreign_field, "nullable": e.nullable}
            for e in schema.edges
        ],
        "relations": [
            {"parentModel": r.parent_model, "childModel": r.child_model,
             "parentField": r.parent_field, "childField": r.child_field}
            for r in schema.relations
        ],
        "scopeField": schema.scope_field,
    }
    return HandlerResponse(status=200, body={**_build_sdk_meta(config), "schema": schema_dict})


async def _handle_up(config: HandlerConfig, body: dict[str, Any]) -> HandlerResponse:
    create = body.get("create")
    if not create:
        raise invalid_body('missing "create" in request body')

    test_run_id: str = body.get("testRunId", str(uuid.uuid4()))
    introspection = await _get_introspection(config)
    schema = introspection.schema
    dialect = get_dialect(config.dialect)

    tree = resolve_tree(create, schema)
    refs: dict[str, list[dict[str, Any]]] = {}
    id_map: dict[str, str] = {}

    async def do_up(tx: Any) -> None:
        nonlocal refs
        i = 0
        while i < len(tree.ops):
            op = tree.ops[i]
            model = op.model

            # Collect consecutive ops for the same model with same batch flag
            batch = [op]
            while i + 1 < len(tree.ops) and tree.ops[i + 1].model == model and tree.ops[i + 1].batch == op.batch:
                i += 1
                batch.append(tree.ops[i])

            # Find model info for auto-populating fields
            model_info = next((m for m in schema.models if m.name == model), None)

            resolved_fields: list[dict[str, Any]] = []
            for b in batch:
                fields = {k: v for k, v in b.fields.items() if k != "id"}

                # Replace temp IDs with real IDs
                for key, value in list(fields.items()):
                    if isinstance(value, str) and value.startswith("__temp_"):
                        real_id = id_map.get(value)
                        if real_id:
                            fields[key] = real_id

                # Inject scope field if applicable
                scope_edge = None
                for e in schema.edges:
                    if e.from_model == model and e.local_field.lower() == schema.scope_field.lower() and e.from_model != e.to_model:
                        scope_edge = e
                        break
                if scope_edge and scope_edge.local_field not in fields:
                    scope_val = _detect_scope_value(refs, schema.scope_field)
                    if scope_val:
                        fields[scope_edge.local_field] = scope_val

                # Auto-populate required DateTime fields without defaults
                if model_info:
                    for field in model_info.fields:
                        if field.is_required and not field.has_default and not field.is_id and field.name not in fields:
                            if field.type == "DateTime":
                                fields[field.name] = datetime.now(timezone.utc)

                resolved_fields.append(fields)

            spec = {model: {"count": len(resolved_fields), "fields": resolved_fields, "batch": op.batch}}
            created = await create_entities(tx, dialect, introspection.table_map, introspection.column_maps, spec, introspection.enum_type_maps)
            records = created.get(model, [])

            if model not in refs:
                refs[model] = []
            refs[model].extend(records)

            for j, b in enumerate(batch):
                if j < len(records):
                    record = records[j]
                    record_id = record.get("id")
                    if isinstance(record_id, str):
                        id_map[b.temp_id] = record_id

            i += 1

        # Resolve deferred FK updates
        for deferred in tree.deferred_updates:
            real_target_id = id_map.get(deferred.target_temp_id)
            ref_temp_id = tree.aliases.get(deferred.ref_alias)
            real_ref_id = id_map.get(ref_temp_id) if ref_temp_id else None

            if not real_target_id or not real_ref_id:
                raise ValueError(
                    f'_ref "{deferred.ref_alias}" could not be resolved. '
                    f'Ensure the referenced node has _alias defined in the scenario.'
                )

            await update_entity(
                tx, dialect, introspection.table_map, introspection.column_maps,
                deferred.model, real_target_id, {deferred.field: real_ref_id},
                introspection.enum_type_maps,
            )

    await config.executor.transaction(do_up)

    scope_value = _detect_scope_value(refs, schema.scope_field) or test_run_id

    first_user = _find_first_user(refs)
    auth = config.auth(first_user)

    refs_token = sign_refs(
        {"refs": refs, "testRunId": scope_value, "environment": ""},
        config.signing_secret,
    )

    return HandlerResponse(status=200, body={**_build_sdk_meta(config), "auth": auth, "refs": refs, "refsToken": refs_token})


async def _handle_down(config: HandlerConfig, body: dict[str, Any]) -> HandlerResponse:
    refs_token = body.get("refsToken")
    if not refs_token:
        raise invalid_body("missing refsToken")

    try:
        payload = verify_refs(refs_token, config.signing_secret)
    except Exception as e:
        raise invalid_refs_token(str(e))

    introspection = await _get_introspection(config)
    dialect = get_dialect(config.dialect)

    await teardown(
        config.executor, dialect,
        introspection.table_map, introspection.column_maps,
        introspection.schema, payload["testRunId"], payload.get("refs"),
    )

    return HandlerResponse(status=200, body={**_build_sdk_meta(config), "ok": True})


def _find_first_user(refs: dict[str, list[dict[str, Any]]]) -> dict[str, Any] | None:
    for model, records in refs.items():
        if model.lower() == "user" and records:
            return records[0]
    return None


def _detect_scope_value(refs: dict[str, list[dict[str, Any]]], scope_field: str) -> str | None:
    scope_lower = scope_field.lower()
    for records in refs.values():
        for record in records:
            for key, value in record.items():
                if key.lower() == scope_lower and isinstance(value, str):
                    return value
    return None
