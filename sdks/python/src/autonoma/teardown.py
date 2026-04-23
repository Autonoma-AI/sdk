"""Tear down scoped test data via raw SQL DELETE in reverse topological order."""

from __future__ import annotations

from typing import Any

from .types import SQLExecutor, SchemaInfo
from .graph import topo_sort, find_deferrable_edge


def compute_teardown_order(schema: SchemaInfo) -> dict[str, Any]:
    """Compute the teardown order for models (reverse topological order).

    Returns a dict with:
      - order: list of model names in deletion order (excluding scope root)
      - scope_root_model: the scope root model name (deleted last)
      - cycles: list of cycle lists
      - scope_field_by_model: map of model → FK field pointing to scope root
      - edge_dicts: edge list in dict format for graph module
    """
    edge_dicts = [
        {"from": e.from_model, "to": e.to_model, "localField": e.local_field,
         "foreignField": e.foreign_field, "nullable": e.nullable}
        for e in schema.edges
    ]

    scope_root_model: str | None = None
    for edge in schema.edges:
        if edge.local_field.lower() == schema.scope_field.lower() and edge.to_model != edge.from_model:
            scope_root_model = edge.to_model
            break

    scope_field_by_model: dict[str, str] = {}
    if scope_root_model:
        for edge in schema.edges:
            if edge.to_model == scope_root_model and edge.from_model != scope_root_model:
                scope_field_by_model[edge.from_model] = edge.local_field

    model_names = [m.name for m in schema.models]
    result = topo_sort(model_names, edge_dicts)
    sorted_models: list[str] = result["sorted"]
    cycles: list[list[str]] = result["cycles"]

    # Build condensation graph
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

    # Flatten in reverse condensation order, excluding scope root
    order: list[str] = []
    for comp_idx in reversed(cond_order):
        for model in components[comp_idx]:
            if model != scope_root_model:
                order.append(model)

    return {
        "order": order,
        "scope_root_model": scope_root_model,
        "cycles": cycles,
        "scope_field_by_model": scope_field_by_model,
        "edge_dicts": edge_dicts,
    }


async def teardown(
    executor: SQLExecutor,
    dialect: Any,
    table_map: dict[str, str],
    column_maps: dict[str, dict[str, str]],
    schema: SchemaInfo,
    scope_value: str,
    refs: dict[str, list[dict[str, Any]]] | None = None,
    skip_models: set[str] | None = None,
) -> None:
    """Delete all data scoped to scope_value in reverse topological order."""
    td = compute_teardown_order(schema)
    scope_root_model = td["scope_root_model"]
    cycles = td["cycles"]
    scope_field_by_model = td["scope_field_by_model"]
    edge_dicts = td["edge_dicts"]
    order = td["order"]

    async def do_teardown(tx: SQLExecutor) -> None:
        # Break cycles by nullifying deferrable FKs
        for cycle in cycles:
            edge = find_deferrable_edge(cycle, edge_dicts)
            if not edge:
                continue
            scope_fk = scope_field_by_model.get(edge["from"])
            if not scope_fk:
                continue
            db_table = table_map.get(edge["from"])
            if not db_table:
                continue
            col_map = column_maps.get(edge["from"], {})
            db_fk_col = col_map.get(edge["localField"], edge["localField"])
            db_scope_col = col_map.get(scope_fk, scope_fk)
            await tx.query(
                f"UPDATE {dialect.quote_id(db_table)} SET {dialect.quote_id(db_fk_col)} = NULL "
                f"WHERE {dialect.quote_id(db_scope_col)} = {dialect.param(1)}",
                [scope_value],
            )

        # Delete in order, skipping factory-teardown models
        for model in order:
            if skip_models and model in skip_models:
                continue
            await _delete_model(tx, dialect, table_map, column_maps, model,
                                scope_value, scope_field_by_model, refs, schema)

        # Delete scope root last (unless skipped by factory teardown)
        if not scope_root_model or (skip_models and scope_root_model in skip_models):
            return
        db_table = table_map.get(scope_root_model)
        if not db_table:
            return
        col_map = column_maps.get(scope_root_model, {})
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
