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
        # Break cycles by nullifying deferrable FKs
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

        # Delete cycle nodes
        for cycle in cycles:
            for model in cycle:
                await _delete_model(tx, dialect, table_map, column_maps, model,
                                    scope_value, scope_field_by_model, refs)

        # Delete in reverse topo order
        for model in reversed(sorted_models):
            if model == scope_root_model:
                continue
            await _delete_model(tx, dialect, table_map, column_maps, model,
                                scope_value, scope_field_by_model, refs)

        # Delete scope root last
        if scope_root_model:
            db_table = table_map.get(scope_root_model)
            col_map = column_maps.get(scope_root_model, {})
            if db_table:
                id_col = col_map.get("id", "id")
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
) -> None:
    db_table = table_map.get(model)
    if not db_table:
        return
    col_map = column_maps.get(model, {})

    scope_fk = scope_field_by_model.get(model)
    if scope_fk:
        db_col = col_map.get(scope_fk, scope_fk)
        await tx.query(
            f"DELETE FROM {dialect.quote_id(db_table)} WHERE {dialect.quote_id(db_col)} = {dialect.param(1)}",
            [scope_value],
        )
    elif refs and model in refs:
        ids = [r.get("id") for r in refs[model] if isinstance(r.get("id"), str)]
        if ids:
            id_col = col_map.get("id", "id")
            placeholders = ", ".join(dialect.param(i + 1) for i in range(len(ids)))
            await tx.query(
                f"DELETE FROM {dialect.quote_id(db_table)} WHERE {dialect.quote_id(id_col)} IN ({placeholders})",
                ids,
            )
