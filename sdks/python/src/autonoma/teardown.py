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

        # Build condensation graph: each SCC is a super-node, each sorted node
        # is its own node. Topo-sort the condensation DAG and delete in reverse
        # order so that dependents of cycles are deleted before the cycle itself.
        components: list[list[str]] = []
        node_to_comp: dict[str, int] = {}

        for cycle in cycles:
            idx = len(components)
            components.append(cycle)
            for node in cycle:
                node_to_comp[node] = idx
        for node in sorted_models:
            node_to_comp[node] = len(components)
            components.append([node])

        # Build condensation DAG edges (dependency → dependent)
        cond_adj: dict[int, set[int]] = {i: set() for i in range(len(components))}
        cond_in_deg: dict[int, int] = {i: 0 for i in range(len(components))}
        for edge in edge_dicts:
            if edge["from"] == edge["to"]:
                continue
            fc = node_to_comp.get(edge["from"])
            tc = node_to_comp.get(edge["to"])
            if fc is not None and tc is not None and fc != tc and fc not in cond_adj[tc]:
                cond_adj[tc].add(fc)
                cond_in_deg[fc] = cond_in_deg.get(fc, 0) + 1

        # Kahn's algorithm on the condensation DAG
        cond_queue = sorted(i for i, d in cond_in_deg.items() if d == 0)
        cond_order: list[int] = []
        while cond_queue:
            cond_queue.sort()
            idx = cond_queue.pop(0)
            cond_order.append(idx)
            for neighbor in cond_adj[idx]:
                cond_in_deg[neighbor] -= 1
                if cond_in_deg[neighbor] == 0:
                    cond_queue.append(neighbor)

        # Delete in reverse condensation order (dependents first)
        for comp_idx in reversed(cond_order):
            for model in components[comp_idx]:
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
