"""Introspect a database via information_schema to build SchemaInfo."""

from __future__ import annotations

import asyncio
import re
from typing import Any

from .types import (
    SQLExecutor, SchemaInfo, ModelInfo, FieldInfo, FKEdge, SchemaRelation,
    IntrospectionResult,
)
from .dialect import get_dialect


async def introspect_database(
    executor: SQLExecutor,
    dialect: Any,
    *,
    scope_field: str,
    schema: str | None = None,
    table_name_map: dict[str, str] | None = None,
    exclude_tables: list[str] | None = None,
) -> IntrospectionResult:
    db_schema = schema or ("public" if dialect.name != "mysql" else None)
    if not db_schema:
        raise ValueError("MySQL requires a schema (database name). Pass it via db_schema or HandlerConfig.db_schema.")

    exclude_set = set(exclude_tables or ["_prisma_migrations"])

    # Run all introspection queries in parallel
    table_rows, column_rows, pk_rows, fk_rows, enum_rows = await asyncio.gather(
        executor.query(dialect.tables_sql(db_schema)),
        executor.query(dialect.columns_sql(db_schema)),
        executor.query(dialect.primary_keys_sql(db_schema)),
        executor.query(dialect.foreign_keys_sql(db_schema)),
        executor.query(dialect.enums_sql(db_schema)),
    )

    # Normalize keys to lowercase (MySQL info_schema can return uppercase)
    table_rows = _normalize_keys(table_rows)
    column_rows = _normalize_keys(column_rows)
    pk_rows = _normalize_keys(pk_rows)
    fk_rows = _normalize_keys(fk_rows)
    enum_rows = _normalize_keys(enum_rows)

    # Build enum lookup
    enum_values: dict[str, list[str]] = {}
    for row in enum_rows:
        name = row.get("enum_name")
        if not name:
            continue
        enum_values.setdefault(name, []).append(row["enum_value"])

    # MySQL: parse inline enums from column_type
    if dialect.name == "mysql":
        for col in column_rows:
            parsed = _parse_mysql_enum(col.get("udt_name", ""))
            if parsed:
                key = f"{col['table_name']}.{col['column_name']}"
                enum_values[key] = parsed

    # Build PK lookup
    pks_by_table: dict[str, set[str]] = {}
    for row in pk_rows:
        pks_by_table.setdefault(row["table_name"], set()).add(row["column_name"])

    # Build table name mapping
    user_map = table_name_map or {}
    table_map: dict[str, str] = {}
    reverse_table_map: dict[str, str] = {}

    for model, db_table in user_map.items():
        table_map[model] = db_table
        reverse_table_map[db_table] = model

    db_tables = [r["table_name"] for r in table_rows if r["table_name"] not in exclude_set]
    for db_table in db_tables:
        if db_table in reverse_table_map:
            continue
        model_name = _snake_to_pascal(db_table)
        table_map[model_name] = db_table
        reverse_table_map[db_table] = model_name

    # Group columns by table
    columns_by_table: dict[str, list[dict[str, Any]]] = {}
    for row in column_rows:
        columns_by_table.setdefault(row["table_name"], []).append(row)

    # Build models and column maps
    models: list[ModelInfo] = []
    column_maps: dict[str, dict[str, str]] = {}
    enum_type_maps: dict[str, dict[str, str]] = {}

    for model_name, db_table in table_map.items():
        cols = columns_by_table.get(db_table, [])
        pks = pks_by_table.get(db_table, set())
        col_map: dict[str, str] = {}
        fields: list[FieldInfo] = []

        for col in cols:
            field_name = _snake_to_camel(col["column_name"])
            col_map[field_name] = col["column_name"]

            # Check for enums
            enum_vals: list[str] | None = None
            if dialect.name == "mysql":
                enum_vals = enum_values.get(f"{col['table_name']}.{col['column_name']}")
            else:
                enum_vals = enum_values.get(col.get("udt_name", ""))

            if enum_vals:
                field_type = f"enum({','.join(enum_vals)})"
            else:
                field_type = _map_data_type(col["data_type"], col.get("udt_name", ""), dialect.name)

            # Track Postgres types needing casts
            if dialect.name == "postgres":
                if enum_vals:
                    enum_type_maps.setdefault(model_name, {})[field_name] = col.get("udt_name", "")
                elif col["data_type"] in ("jsonb", "json") or col.get("udt_name", "") in ("jsonb", "json"):
                    json_type = "json" if (col["data_type"] == "json" or col.get("udt_name") == "json") else "jsonb"
                    enum_type_maps.setdefault(model_name, {})[field_name] = json_type
                elif "timestamp" in col["data_type"] or col.get("udt_name", "") in ("timestamptz", "timestamp"):
                    enum_type_maps.setdefault(model_name, {})[field_name] = col.get("udt_name", "")

            fields.append(FieldInfo(
                name=field_name,
                type=field_type,
                is_required=col["is_nullable"] == "NO",
                is_id=col["column_name"] in pks,
                has_default=col["column_default"] is not None,
            ))

        column_maps[model_name] = col_map
        models.append(ModelInfo(name=model_name, table_name=db_table, fields=fields))

    # Build FK edges
    edges: list[FKEdge] = []
    for fk in fk_rows:
        from_model = reverse_table_map.get(fk["from_table"])
        to_model = reverse_table_map.get(fk["to_table"])
        if not from_model or not to_model:
            continue

        from_col_map = column_maps.get(from_model, {})
        to_col_map = column_maps.get(to_model, {})
        local_field = _reverse_get(from_col_map, fk["from_column"]) or fk["from_column"]
        foreign_field = _reverse_get(to_col_map, fk["to_column"]) or fk["to_column"]

        edges.append(FKEdge(
            from_model=from_model,
            to_model=to_model,
            local_field=local_field,
            foreign_field=foreign_field,
            nullable=fk["is_nullable"] == "YES",
        ))

    # Build relations from FK edges
    relations: list[SchemaRelation] = []
    for edge in edges:
        from_db_table = table_map.get(edge.from_model, "")
        from_col_map = column_maps.get(edge.from_model, {})
        fk_db_col = from_col_map.get(edge.local_field, edge.local_field)
        from_pks = pks_by_table.get(from_db_table, set())
        is_one_to_one = len(from_pks) == 1 and fk_db_col in from_pks

        # Parent-side
        relations.append(SchemaRelation(
            parent_model=edge.to_model,
            child_model=edge.from_model,
            parent_field=_lower_first(edge.from_model) if is_one_to_one else _plural_camel_case(edge.from_model),
            child_field=edge.local_field,
        ))

        # Child-side
        relations.append(SchemaRelation(
            parent_model=edge.from_model,
            child_model=edge.to_model,
            parent_field=_lower_first(edge.to_model),
            child_field=edge.local_field,
        ))

    schema_info = SchemaInfo(models=models, edges=edges, relations=relations, scope_field=scope_field)
    return IntrospectionResult(
        schema=schema_info,
        table_map=table_map,
        column_maps=column_maps,
        enum_type_maps=enum_type_maps,
    )


# --- Name mapping utilities ---

def _snake_to_pascal(s: str) -> str:
    return "".join(part[0].upper() + part[1:] for part in s.split("_") if part)


def _snake_to_camel(s: str) -> str:
    pascal = _snake_to_pascal(s)
    return pascal[0].lower() + pascal[1:] if pascal else ""


def _lower_first(s: str) -> str:
    return s[0].lower() + s[1:] if s else ""


def _plural_camel_case(model_name: str) -> str:
    camel = _lower_first(model_name)
    return _pluralize(camel)


def _pluralize(s: str) -> str:
    if s.endswith(("s", "x", "z", "ch", "sh")):
        return s + "es"
    if s.endswith("y") and len(s) > 1 and s[-2] not in "aeiou":
        return s[:-1] + "ies"
    return s + "s"


def _parse_mysql_enum(column_type: str) -> list[str] | None:
    if not column_type:
        return None
    match = re.match(r"^enum\((.+)\)$", column_type, re.IGNORECASE)
    if not match:
        return None
    return [v.strip().strip("'") for v in match.group(1).split(",")]


def _map_data_type(data_type: str, udt_name: str, dialect_name: str) -> str:
    dt = data_type.lower()
    # MySQL: tinyint(1) is conventionally Boolean
    if dialect_name == "mysql" and dt == "tinyint" and udt_name.lower().startswith("tinyint(1)"):
        return "Boolean"
    if dt in ("integer", "smallint", "bigint", "int", "mediumint", "tinyint"):
        return "Int"
    if dt in ("numeric", "real", "double precision", "float", "double", "decimal"):
        return "Float"
    if dt in ("boolean",):
        return "Boolean"
    if dt in ("text", "character varying", "character", "varchar", "char", "mediumtext", "longtext", "tinytext"):
        return "String"
    if dt in ("timestamp with time zone", "timestamp without time zone", "date", "time", "datetime", "timestamp"):
        return "DateTime"
    if dt in ("json", "jsonb"):
        return "Json"
    if dt == "uuid":
        return "String"
    if dt in ("bytea", "blob", "mediumblob", "longblob", "tinyblob", "binary", "varbinary"):
        return "Bytes"
    if dt == "user-defined" and dialect_name == "postgres":
        return udt_name
    if dt in ("enum", "set"):
        return udt_name
    return data_type


def _normalize_keys(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{k.lower(): v for k, v in row.items()} for row in rows]


def _reverse_get(mapping: dict[str, str], db_name: str) -> str | None:
    for key, val in mapping.items():
        if val == db_name:
            return key
    return None
