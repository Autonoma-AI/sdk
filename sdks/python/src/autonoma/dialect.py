"""Database dialect abstraction — generates dialect-specific SQL strings."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from .generated.sql_queries import (
    POSTGRES_TABLES,
    POSTGRES_COLUMNS,
    POSTGRES_PRIMARY_KEYS,
    POSTGRES_FOREIGN_KEYS,
    POSTGRES_ENUMS,
    MYSQL_TABLES,
    MYSQL_COLUMNS,
    MYSQL_PRIMARY_KEYS,
    MYSQL_FOREIGN_KEYS,
    MYSQL_ENUMS,
)


def _replace_schema(template: str, schema: str) -> str:
    return template.replace("{{schema}}", schema)


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
        return _replace_schema(POSTGRES_TABLES, schema)

    def columns_sql(self, schema: str) -> str:
        return _replace_schema(POSTGRES_COLUMNS, schema)

    def primary_keys_sql(self, schema: str) -> str:
        return _replace_schema(POSTGRES_PRIMARY_KEYS, schema)

    def foreign_keys_sql(self, schema: str) -> str:
        return _replace_schema(POSTGRES_FOREIGN_KEYS, schema)

    def enums_sql(self, _schema: str) -> str:
        return POSTGRES_ENUMS


@dataclass
class MySQLDialect:
    name: str = "mysql"
    supports_returning: bool = False

    def param(self, _index: int) -> str:
        return "?"

    def quote_id(self, name: str) -> str:
        return f"`{name}`"

    def tables_sql(self, schema: str) -> str:
        return _replace_schema(MYSQL_TABLES, schema)

    def columns_sql(self, schema: str) -> str:
        return _replace_schema(MYSQL_COLUMNS, schema)

    def primary_keys_sql(self, schema: str) -> str:
        return _replace_schema(MYSQL_PRIMARY_KEYS, schema)

    def foreign_keys_sql(self, schema: str) -> str:
        return _replace_schema(MYSQL_FOREIGN_KEYS, schema)

    def enums_sql(self, _schema: str) -> str:
        return MYSQL_ENUMS


def get_dialect(name: str = "postgres") -> PostgresDialect | MySQLDialect:
    if name == "postgres":
        return PostgresDialect()
    elif name == "mysql":
        return MySQLDialect()
    else:
        raise ValueError(f'Dialect "{name}" is not yet supported. Currently only "postgres" and "mysql" are available.')
