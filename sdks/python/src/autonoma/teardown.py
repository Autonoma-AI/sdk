"""Tear down scoped test data via raw SQL DELETE in reverse topological order."""

from __future__ import annotations

from typing import Any

from .types import SQLExecutor, SchemaInfo
from .graph import topo_sort, find_deferrable_edge


async def teardown(
    executor: SQLExecutor,
    dialect: Any,
    table_map: dict[str, str],
    column_maps: dict[str, dict[str, str]],
    schema: SchemaInfo,
    scope_value: str,
    refs: dict[str, list[dict[str, Any]]] | None = None,
) -> None:
    """Delete all data scoped to scope_value in reverse topological order."""
    # Convert edges to dict format for graph module
    edge_dicts = [
        {"from": e.from_model, "to": e.to_model, "localField": e.local_field,
         "foreignField": e.foreign_field, "nullable": e.nullable}
        for e in schema.edges
    ]

    # Find scope root model
    scope_root_model: str | None = None
    for edge in schema.edges:
        if edge.local_field.lower() == schema.scope_field.lower() and edge.to_model != edge.from_model:
            scope_root_model = edge.to_model
            break

    # Build map: model → FK field pointing to scope root
    scope_field_by_model: dict[str, str] = {}
    if scope_root_model:
        for edge in schema.edges:
            if edge.to_model == scope_root_model and edge.from_model != scope_root_model:
                scope_field_by_model[edge.from_model] = edge.local_field

    model_names = [m.name for m in schema.models]
    result = topo_sort(model_names, edge_dicts)
    sorted_models: list[str] = result["sorted"]
    cycles: list[list[str]] = result["cycles"]

    async def do_teardown(tx: SQLExecutor) -> None:
        # 1. Break cycles by nullifying deferrable FKs
        for cycle in cycles:
            edge = find_deferrable_edge(cycle, edge_dicts)
            if edge:
                scope_fk = scope_field_by_model.get(edge["from"])
                if scope_fk:
                    db_table = table_map.get(edge["from"])
                    col_map = column_maps.get(edge["from"], {})
                    if db_table:
                        db_fk_col = col_map.get(edge["localField"], edge["localField"])
                        db_scope_col = col_map.get(scope_fk, scope_fk)
                        await tx.query(
                            f"UPDATE {dialect.quote_id(db_table)} SET {dialect.quote_id(db_fk_col)} = NULL "
                            f"WHERE {dialect.quote_id(db_scope_col)} = {dialect.param(1)}",
                            [scope_value],
                        )

        # Partition sorted nodes: those that depend on cycle nodes must be deleted
        # BEFORE cycles, those that cycle nodes depend on must be deleted AFTER.
        cycle_node_set = set()
        for cycle in cycles:
            cycle_node_set.update(cycle)

        if cycle_node_set:
            # Build dependency map: node → set of nodes it depends on
            depends_on: dict[str, set[str]] = {}
            for edge in edge_dicts:
                if edge["from"] != edge["to"]:
                    depends_on.setdefault(edge["from"], set()).add(edge["to"])

            # Mark nodes that transitively depend on cycle nodes
            depends_on_cycle: set[str] = set()
            for node in sorted_models:
                deps = depends_on.get(node, set())
                if any(d in cycle_node_set or d in depends_on_cycle for d in deps):
                    depends_on_cycle.add(node)

            cycle_dependents = [n for n in sorted_models if n in depends_on_cycle]
            cycle_deps = [n for n in sorted_models if n not in depends_on_cycle]

            for model in reversed(cycle_dependents):
                if model == scope_root_model:
                    continue
                await _delete_model(tx, dialect, table_map, column_maps, model,
                                    scope_value, scope_field_by_model, refs, schema)

            for cycle in cycles:
                for model in cycle:
                    await _delete_model(tx, dialect, table_map, column_maps, model,
                                        scope_value, scope_field_by_model, refs, schema)

            for model in reversed(cycle_deps):
                if model == scope_root_model:
                    continue
                await _delete_model(tx, dialect, table_map, column_maps, model,
                                    scope_value, scope_field_by_model, refs, schema)
        else:
            for model in reversed(sorted_models):
                if model == scope_root_model:
                    continue
                await _delete_model(tx, dialect, table_map, column_maps, model,
                                    scope_value, scope_field_by_model, refs, schema)

        # 4. Delete scope root last
        if scope_root_model:
            db_table = table_map.get(scope_root_model)
            col_map = column_maps.get(scope_root_model, {})
            if db_table:
                # Bug 4: Use actual PK field name from schema (composite PK: prefer "id")
                root_model_info = next((m for m in schema.models if m.name == scope_root_model), None)
                root_id_fields = [f for f in root_model_info.fields if f.is_id] if root_model_info else []
                root_pk_field = next((f for f in root_id_fields if f.name.lower() == "id"), root_id_fields[0] if root_id_fields else None)
                root_pk_field_name = root_pk_field.name if root_pk_field else "id"
                id_col = col_map.get(root_pk_field_name, root_pk_field_name)
                await tx.query(
                    f"DELETE FROM {dialect.quote_id(db_table)} WHERE {dialect.quote_id(id_col)} = {dialect.param(1)}",
                    [scope_value],
                )

    await executor.transaction(do_teardown)


async def _delete_model(
    tx: SQLExecutor,
    dialect: Any,
    table_map: dict[str, str],
    column_maps: dict[str, dict[str, str]],
    model: str,
    scope_value: str,
    scope_field_by_model: dict[str, str],
    refs: dict[str, list[dict[str, Any]]] | None,
    schema: SchemaInfo,
) -> None:
    db_table = table_map.get(model)
    if not db_table:
        return
    col_map = column_maps.get(model, {})

    # Bug 4: Find actual PK field name from schema
    # When multiple isId fields exist (composite PK), prefer the one named "id"
    model_info = next((m for m in schema.models if m.name == model), None)
    id_fields = [f for f in model_info.fields if f.is_id] if model_info else []
    pk_field = next((f for f in id_fields if f.name.lower() == "id"), id_fields[0] if id_fields else None)
    pk_field_name = pk_field.name if pk_field else "id"

    scope_fk = scope_field_by_model.get(model)
    if scope_fk:
        db_col = col_map.get(scope_fk, scope_fk)
        await tx.query(
            f"DELETE FROM {dialect.quote_id(db_table)} WHERE {dialect.quote_id(db_col)} = {dialect.param(1)}",
            [scope_value],
        )
    elif refs and model in refs:
        # Bug 3/4: Use pk_field_name and accept both str and int IDs
        ids = [r.get(pk_field_name) for r in refs[model] if r.get(pk_field_name) is not None]
        if ids:
            id_col = col_map.get(pk_field_name, pk_field_name)
            placeholders = ", ".join(dialect.param(i + 1) for i in range(len(ids)))
            await tx.query(
                f"DELETE FROM {dialect.quote_id(db_table)} WHERE {dialect.quote_id(id_col)} IN ({placeholders})",
                ids,
            )
