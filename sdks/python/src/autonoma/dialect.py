"""Database dialect abstraction — generates dialect-specific SQL strings."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


class Dialect(Protocol):
    name: str
    supports_returning: bool

    def param(self, index: int) -> str: ...
    def quote_id(self, name: str) -> str: ...
    def tables_sql(self, schema: str) -> str: ...
    def columns_sql(self, schema: str) -> str: ...
    def primary_keys_sql(self, schema: str) -> str: ...
    def foreign_keys_sql(self, schema: str) -> str: ...
    def enums_sql(self, schema: str) -> str: ...


@dataclass
class PostgresDialect:
    name: str = "postgres"
    supports_returning: bool = True

    def param(self, index: int) -> str:
        return f"${index}"

    def quote_id(self, name: str) -> str:
        return f'"{name}"'

    def tables_sql(self, schema: str) -> str:
        return f"""
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = '{schema}'
              AND table_type = 'BASE TABLE'
            ORDER BY table_name
        """

    def columns_sql(self, schema: str) -> str:
        return f"""
            SELECT
              table_name,
              column_name,
              data_type,
              udt_name,
              is_nullable,
              column_default
            FROM information_schema.columns
            WHERE table_schema = '{schema}'
            ORDER BY table_name, ordinal_position
        """

    def primary_keys_sql(self, schema: str) -> str:
        return f"""
            SELECT
              tc.table_name,
              kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
              AND tc.table_schema = kcu.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY'
              AND tc.table_schema = '{schema}'
            ORDER BY tc.table_name, kcu.ordinal_position
        """

    def foreign_keys_sql(self, schema: str) -> str:
        return f"""
            SELECT
              kcu.table_name AS from_table,
              kcu.column_name AS from_column,
              ccu.table_name AS to_table,
              ccu.column_name AS to_column,
              c.is_nullable
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
              AND tc.table_schema = kcu.table_schema
            JOIN information_schema.constraint_column_usage ccu
              ON tc.constraint_name = ccu.constraint_name
              AND tc.table_schema = ccu.table_schema
            LEFT JOIN information_schema.columns c
              ON c.table_schema = kcu.table_schema
              AND c.table_name = kcu.table_name
              AND c.column_name = kcu.column_name
            WHERE tc.constraint_type = 'FOREIGN KEY'
              AND tc.table_schema = '{schema}'
            ORDER BY kcu.table_name, kcu.ordinal_position
        """

    def enums_sql(self, _schema: str) -> str:
        return """
            SELECT t.typname AS enum_name, e.enumlabel AS enum_value
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
            ORDER BY t.typname, e.enumsortorder
        """


@dataclass
class MySQLDialect:
    name: str = "mysql"
    supports_returning: bool = False

    def param(self, _index: int) -> str:
        return "?"

    def quote_id(self, name: str) -> str:
        return f"`{name}`"

    def tables_sql(self, schema: str) -> str:
        return f"""
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = '{schema}'
              AND table_type = 'BASE TABLE'
            ORDER BY table_name
        """

    def columns_sql(self, schema: str) -> str:
        return f"""
            SELECT
              table_name,
              column_name,
              data_type,
              column_type AS udt_name,
              is_nullable,
              column_default
            FROM information_schema.columns
            WHERE table_schema = '{schema}'
            ORDER BY table_name, ordinal_position
        """

    def primary_keys_sql(self, schema: str) -> str:
        return f"""
            SELECT
              tc.table_name,
              kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
              AND tc.table_schema = kcu.table_schema
              AND tc.table_name = kcu.table_name
            WHERE tc.constraint_type = 'PRIMARY KEY'
              AND tc.table_schema = '{schema}'
            ORDER BY tc.table_name, kcu.ordinal_position
        """

    def foreign_keys_sql(self, schema: str) -> str:
        return f"""
            SELECT
              kcu.table_name AS from_table,
              kcu.column_name AS from_column,
              kcu.referenced_table_name AS to_table,
              kcu.referenced_column_name AS to_column,
              c.is_nullable
            FROM information_schema.key_column_usage kcu
            JOIN information_schema.columns c
              ON c.table_schema = kcu.table_schema
              AND c.table_name = kcu.table_name
              AND c.column_name = kcu.column_name
            WHERE kcu.referenced_table_name IS NOT NULL
              AND kcu.table_schema = '{schema}'
            ORDER BY kcu.table_name, kcu.ordinal_position
        """

    def enums_sql(self, _schema: str) -> str:
        return "SELECT NULL AS enum_name, NULL AS enum_value FROM DUAL WHERE 1 = 0"


def get_dialect(name: str = "postgres") -> PostgresDialect | MySQLDialect:
    if name == "postgres":
        return PostgresDialect()
    elif name == "mysql":
        return MySQLDialect()
    else:
        raise ValueError(f'Dialect "{name}" is not yet supported. Currently only "postgres" and "mysql" are available.')
