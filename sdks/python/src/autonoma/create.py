"""Create entities via raw SQL INSERT."""

from __future__ import annotations

import json
import re
import uuid
from datetime import date, datetime
from typing import Any

from .types import SQLExecutor

_MYSQL_DATETIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")


async def create_entities(
    executor: SQLExecutor,
    dialect: Any,
    table_map: dict[str, str],
    column_maps: dict[str, dict[str, str]],
    spec: dict[str, dict[str, Any]],
    enum_type_maps: dict[str, dict[str, str]] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Create entities from a resolved spec. Spec maps model name → {count, fields[], batch}."""
    enum_type_maps = enum_type_maps or {}
    results: dict[str, list[dict[str, Any]]] = {}

    for model, entity_spec in spec.items():
        db_table = table_map.get(model)
        if not db_table:
            raise ValueError(f'Unknown model "{model}". Not found in database tables.')
        col_map = column_maps.get(model, {})
        enum_type_map = enum_type_maps.get(model, {})

        fields_list: list[dict[str, Any]] = entity_spec.get("fields", [])
        is_batch = entity_spec.get("batch", False)

        if is_batch and fields_list:
            results[model] = await _insert_batch(executor, dialect, db_table, col_map, enum_type_map, fields_list)
        else:
            created: list[dict[str, Any]] = []
            for fields in fields_list:
                rows = await _insert_one(executor, dialect, db_table, col_map, enum_type_map, fields)
                if rows:
                    created.append(rows[0])
            results[model] = created

    return results


async def update_entity(
    executor: SQLExecutor,
    dialect: Any,
    table_map: dict[str, str],
    column_maps: dict[str, dict[str, str]],
    model: str,
    record_id: str,
    fields: dict[str, Any],
    enum_type_maps: dict[str, dict[str, str]] | None = None,
) -> None:
    """Update a single record by primary key. Used for circular FK backfill."""
    db_table = table_map.get(model)
    if not db_table:
        raise ValueError(f'Unknown model "{model}" for update.')
    col_map = column_maps.get(model, {})
    enum_type_map = (enum_type_maps or {}).get(model, {})

    set_clauses: list[str] = []
    params: list[Any] = []
    param_idx = 1

    for field_name, value in fields.items():
        db_col = col_map.get(field_name, field_name)
        set_clauses.append(f"{dialect.quote_id(db_col)} = {_cast_param(dialect, param_idx, enum_type_map, field_name)}")
        params.append(_serialize_value(value, dialect))
        param_idx += 1

    id_col = col_map.get("id", "id")
    params.append(record_id)

    sql = f"UPDATE {dialect.quote_id(db_table)} SET {', '.join(set_clauses)} WHERE {dialect.quote_id(id_col)} = {dialect.param(param_idx)}"
    await executor.query(sql, params)


# --- Internal helpers ---

async def _insert_one(
    executor: SQLExecutor,
    dialect: Any,
    db_table: str,
    col_map: dict[str, str],
    enum_type_map: dict[str, str],
    fields: dict[str, Any],
) -> list[dict[str, Any]]:
    # Generate client-side UUID for 'id' column if not provided
    id_field_name = _reverse_get(col_map, _find_id_col(col_map))
    if id_field_name and id_field_name not in fields:
        fields = {**fields, id_field_name: str(uuid.uuid4())}

    entries = list(fields.items())
    if not entries:
        sql = f"INSERT INTO {dialect.quote_id(db_table)} DEFAULT VALUES RETURNING *"
        return _map_rows_back(await executor.query(sql), col_map)

    db_cols: list[str] = []
    params: list[Any] = []
    placeholders: list[str] = []
    param_idx = 1

    for field_name, value in entries:
        db_col = col_map.get(field_name, field_name)
        db_cols.append(dialect.quote_id(db_col))
        placeholders.append(_cast_param(dialect, param_idx, enum_type_map, field_name))
        params.append(_serialize_value(value, dialect))
        param_idx += 1

    col_list = ", ".join(db_cols)
    val_list = ", ".join(placeholders)

    if dialect.supports_returning:
        sql = f"INSERT INTO {dialect.quote_id(db_table)} ({col_list}) VALUES ({val_list}) RETURNING *"
        return _map_rows_back(await executor.query(sql, params), col_map)

    # MySQL: INSERT then SELECT back
    await executor.query(
        f"INSERT INTO {dialect.quote_id(db_table)} ({col_list}) VALUES ({val_list})",
        params,
    )
    id_col = _find_id_col(col_map)
    record_id = fields.get(id_field_name or "id")
    return _map_rows_back(
        await executor.query(
            f"SELECT * FROM {dialect.quote_id(db_table)} WHERE {dialect.quote_id(id_col)} = {dialect.param(1)}",
            [record_id],
        ),
        col_map,
    )


async def _insert_batch(
    executor: SQLExecutor,
    dialect: Any,
    db_table: str,
    col_map: dict[str, str],
    enum_type_map: dict[str, str],
    fields_arr: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if not fields_arr:
        return []

    # Generate client-side IDs
    id_field_name = _reverse_get(col_map, _find_id_col(col_map))
    if id_field_name:
        fields_arr = [
            {**f, id_field_name: str(uuid.uuid4())} if id_field_name not in f else f
            for f in fields_arr
        ]

    # Compute the union of keys across all rows in deterministic (sorted) order
    all_keys: set[str] = set()
    for f in fields_arr:
        all_keys.update(f.keys())
    field_names = sorted(all_keys)

    # If no fields at all, fall back to individual inserts
    if not field_names:
        all_results: list[dict[str, Any]] = []
        for fields in fields_arr:
            rows = await _insert_one(executor, dialect, db_table, col_map, enum_type_map, fields)
            if rows:
                all_results.append(rows[0])
        return all_results

    db_cols_list = [dialect.quote_id(col_map.get(f, f)) for f in field_names]
    col_list = ", ".join(db_cols_list)

    # Chunk to stay within bind variable limits (Postgres 32,767)
    max_params = 32_000
    chunk_size = max(1, max_params // len(field_names))
    all_results: list[dict[str, Any]] = []

    for offset in range(0, len(fields_arr), chunk_size):
        chunk = fields_arr[offset:offset + chunk_size]
        params: list[Any] = []
        value_tuples: list[str] = []
        param_idx = 1

        for fields in chunk:
            phs: list[str] = []
            for fn in field_names:
                phs.append(_cast_param(dialect, param_idx, enum_type_map, fn))
                params.append(_serialize_value(fields.get(fn), dialect))
                param_idx += 1
            value_tuples.append(f"({', '.join(phs)})")

        val_list = ", ".join(value_tuples)

        if dialect.supports_returning:
            sql = f"INSERT INTO {dialect.quote_id(db_table)} ({col_list}) VALUES {val_list} RETURNING *"
            all_results.extend(_map_rows_back(await executor.query(sql, params), col_map))
        else:
            await executor.query(
                f"INSERT INTO {dialect.quote_id(db_table)} ({col_list}) VALUES {val_list}",
                params,
            )

    return all_results


def _map_rows_back(rows: list[dict[str, Any]], col_map: dict[str, str]) -> list[dict[str, Any]]:
    if not col_map:
        return rows
    reverse = {db_col: field_name for field_name, db_col in col_map.items()}
    return [{reverse.get(k, k): v for k, v in row.items()} for row in rows]


def _find_id_col(col_map: dict[str, str]) -> str:
    return col_map.get("id", "id")


def _reverse_get(mapping: dict[str, str], db_name: str) -> str | None:
    for key, val in mapping.items():
        if val == db_name:
            return key
    return None


def _cast_param(dialect: Any, param_idx: int, enum_type_map: dict[str, str], field_name: str) -> str:
    placeholder = dialect.param(param_idx)
    if dialect.name == "postgres":
        enum_type = enum_type_map.get(field_name)
        if enum_type:
            return f'{placeholder}::{dialect.quote_id(enum_type)}'
    return placeholder


def _serialize_value(value: Any, dialect: Any) -> Any:
    if value is None:
        return value

    # JSON: stringify objects/dicts/lists
    if isinstance(value, (dict, list)):
        return json.dumps(value)

    # Date/datetime objects
    if isinstance(value, datetime):
        if dialect.name == "mysql":
            return value.strftime("%Y-%m-%d %H:%M:%S")
        return value.isoformat()

    if isinstance(value, date):
        return value.isoformat()

    # MySQL: convert ISO 8601 datetime strings
    if isinstance(value, str) and dialect.name == "mysql":
        if _MYSQL_DATETIME_RE.match(value):
            return value.replace("T", " ").replace("Z", "").rstrip("0").rstrip(".")

    return value
