"""Request routing for discover/up/down protocol actions."""

from __future__ import annotations

import asyncio
import inspect
import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any

_TOKEN_RE = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")
_CYCLE_RE = re.compile(r"^cycle\((.*)\)$")


def _resolve_tokens(value: Any, test_run_id: str, index: int) -> Any:
    """Substitute built-in tokens in field values: {{testRunId}}, {{index}}, {{cycle(a,b,c)}}.

    Raises AutonomaError(UNRESOLVED_TOKEN) for any other {{token}} that reaches
    the SDK. Token resolution is defense-in-depth: the test runner should
    substitute recipe variables before calling /up, but if a literal {{…}}
    slips through we would otherwise insert it verbatim into the DB.
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
                    p.strip().strip('"').strip("'")
                    for p in cycle.group(1).split(",")
                ]
                return parts[index % len(parts)] if parts else ""
            raise AutonomaError(
                f'Unresolved token: {{{{{token}}}}}',
                "UNRESOLVED_TOKEN",
                400,
            )

        return _TOKEN_RE.sub(replace, value)
    if isinstance(value, list):
        return [_resolve_tokens(v, test_run_id, index) for v in value]
    if isinstance(value, dict):
        return {k: _resolve_tokens(v, test_run_id, index) for k, v in value.items()}
    return value

from .hmac_util import verify_signature
from .refs import sign_refs, verify_refs
from .errors import AutonomaError, invalid_signature, invalid_body, unknown_action, production_blocked, invalid_refs_token, same_secrets
from .types import AuthContext, FactoryContext, HandlerConfig, HandlerRequest, HandlerResponse, HookContext, IntrospectionResult
from .dialect import get_dialect
from .introspect import introspect_database
from .tree import resolve_tree
from .create import create_entities, update_entity
from .teardown import compute_teardown_order, teardown

def _load_protocol_version() -> str:
    try:
        from pathlib import Path
        return (Path(__file__).resolve().parents[4] / "protocol" / "version.txt").read_text().strip()
    except (OSError, IndexError):
        return "1.0"

PROTOCOL_VERSION = _load_protocol_version()

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
    id_map: dict[str, Any] = {}

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

            # Bug 4: find actual PK field name from schema
            # When multiple isId fields exist (composite PK), prefer the one named "id"
            id_fields = [f for f in model_info.fields if f.is_id] if model_info else []
            pk_field = next((f for f in id_fields if f.name.lower() == "id"), id_fields[0] if id_fields else None)
            pk_field_name = pk_field.name if pk_field else "id"

            resolved_fields: list[dict[str, Any]] = []
            for batch_index, b in enumerate(batch):
                fields = dict(b.fields)

                # Substitute built-in tokens ({{testRunId}}, {{index}}, {{cycle(...)}})
                fields = _resolve_tokens(fields, test_run_id, batch_index)

                # Replace temp IDs with real IDs
                for key, value in list(fields.items()):
                    if isinstance(value, str) and value.startswith("__temp_"):
                        real_id = id_map.get(value)
                        if real_id:
                            fields[key] = real_id

                # Inject scope field if applicable
                scope_edge = None
                for e in schema.edges:
                    if e.from_model == model and e.local_field.replace("_", "").lower() == schema.scope_field.replace("_", "").lower() and e.from_model != e.to_model:
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

            factory = (config.factories or {}).get(model)

            if factory:
                # Factory path: call user-defined create() for each record
                records: list[dict[str, Any]] = []
                for fields in resolved_fields:
                    factory_ctx = FactoryContext(
                        refs=refs,
                        executor=tx,
                        scenario_name=test_run_id,
                        test_run_id=test_run_id,
                    )
                    record = factory.create(fields, factory_ctx)
                    if inspect.isawaitable(record):
                        record = await record
                    if record.get(pk_field_name) is None:
                        raise AutonomaError(
                            f'Factory for "{model}" must return a record with "{pk_field_name}"',
                            "FACTORY_MISSING_PK",
                            500,
                        )
                    records.append(record)
            else:
                # SQL fallback path (existing behavior)
                spec = {model: {"count": len(resolved_fields), "fields": resolved_fields, "batch": op.batch}}
                created = await create_entities(tx, dialect, introspection.table_map, introspection.column_maps, spec, introspection.enum_type_maps, schema.models)
                records = created.get(model, [])

            if model not in refs:
                refs[model] = []
            refs[model].extend(records)

            # Bug 3: Accept both str and int IDs in id_map (remove isinstance check)
            # Bug 4: Use pk_field_name instead of hardcoded "id"
            for j, b in enumerate(batch):
                if j < len(records):
                    record = records[j]
                    record_id = record.get(pk_field_name)
                    if record_id is not None:
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

            deferred_model_info = next((m for m in schema.models if m.name == deferred.model), None)
            deferred_id_fields = [f for f in deferred_model_info.fields if f.is_id] if deferred_model_info else []
            deferred_pk_field = next((f for f in deferred_id_fields if f.name.lower() == "id"), deferred_id_fields[0] if deferred_id_fields else None)
            deferred_pk_field_name = deferred_pk_field.name if deferred_pk_field else "id"

            await update_entity(
                tx, dialect, introspection.table_map, introspection.column_maps,
                deferred.model, str(real_target_id), {deferred.field: real_ref_id},
                introspection.enum_type_maps,
                deferred_pk_field_name,
            )

    await config.executor.transaction(do_up)

    scope_value = _detect_scope_value(refs, schema.scope_field) or test_run_id

    first_user = _find_first_user(refs)
    auth_context = AuthContext(scope_value=scope_value, refs=refs)
    auth = config.auth(first_user, auth_context)
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

    if config.before_down is not None:
        hook_ctx = HookContext(scenario_name=payload["testRunId"], refs=payload.get("refs") or {})
        result = config.before_down(hook_ctx)
        if asyncio.iscoroutine(result):
            await result

    # Determine which models have factory teardown
    factory_teardown_models: set[str] = set()
    if config.factories:
        for model, factory in config.factories.items():
            if factory.teardown is not None:
                factory_teardown_models.add(model)

    # Run factory teardowns in reverse topo order
    if factory_teardown_models:
        td_info = compute_teardown_order(introspection.schema)
        full_order = td_info["order"] + ([td_info["scope_root_model"]] if td_info["scope_root_model"] else [])
        td_refs = payload.get("refs") or {}

        for model in reversed(full_order):
            if model not in factory_teardown_models:
                continue
            records = td_refs.get(model, [])
            factory_ctx = FactoryContext(
                refs=td_refs,
                executor=config.executor,
                scenario_name=payload["testRunId"],
                test_run_id=payload["testRunId"],
            )
            for record in reversed(records):
                result = config.factories[model].teardown(record, factory_ctx)
                if inspect.isawaitable(result):
                    await result

    # SQL teardown for remaining models (skipping factory-teardown ones)
    await teardown(
        config.executor, dialect,
        introspection.table_map, introspection.column_maps,
        introspection.schema, payload["testRunId"], payload.get("refs"),
        skip_models=factory_teardown_models,
    )

    return HandlerResponse(status=200, body={**_build_sdk_meta(config), "ok": True})


def _find_first_user(refs: dict[str, list[dict[str, Any]]]) -> dict[str, Any] | None:
    # Bug 8: Match both "user" and "users" (case-insensitive)
    for model, records in refs.items():
        normalized = model.lower()
        if (normalized == "user" or normalized == "users") and records:
            return records[0]
    return None


def _detect_scope_value(refs: dict[str, list[dict[str, Any]]], scope_field: str) -> str | None:
    # Bug 5: Strip underscores from both sides before comparing
    scope_normalized = scope_field.replace("_", "").lower()
    for records in refs.values():
        for record in records:
            for key, value in record.items():
                if key.replace("_", "").lower() == scope_normalized and isinstance(value, str):
                    return value
    return None
