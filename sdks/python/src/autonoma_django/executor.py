"""Django SQLExecutor wrapper — thin adapter for the SQL-first architecture."""

from __future__ import annotations

import re
from typing import Any, Callable


class DjangoExecutor:
    """Wraps Django's database connection as a SQLExecutor.

    Usage::

        from autonoma_django.executor import django_executor

        executor = django_executor()
        # or with a specific database alias:
        executor = django_executor("secondary")
    """

    def __init__(self, db_alias: str = "default") -> None:
        self._db_alias = db_alias

    async def query(self, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
        from django.db import connections

        conn = connections[self._db_alias]
        pg_sql, pg_params = _convert_params(sql, params)

        with conn.cursor() as cursor:
            cursor.execute(pg_sql, pg_params)
            try:
                columns = [col[0] for col in cursor.description]
                rows = cursor.fetchall()
                return [dict(zip(columns, row)) for row in rows]
            except Exception:
                return []

    async def transaction(self, fn: Callable[..., Any]) -> Any:
        from django.db import connections

        conn = connections[self._db_alias]
        with conn.cursor() as cursor:
            cursor.execute("BEGIN")
            try:
                tx_executor = _TxExecutor(cursor)
                result = await fn(tx_executor)
                cursor.execute("COMMIT")
                return result
            except Exception:
                cursor.execute("ROLLBACK")
                raise


class _TxExecutor:
    """SQLExecutor scoped to an active transaction."""

    def __init__(self, cursor: Any) -> None:
        self._cursor = cursor

    async def query(self, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
        pg_sql, pg_params = _convert_params(sql, params)
        self._cursor.execute(pg_sql, pg_params)
        try:
            columns = [col[0] for col in self._cursor.description]
            rows = self._cursor.fetchall()
            return [dict(zip(columns, row)) for row in rows]
        except Exception:
            return []

    async def transaction(self, fn: Any) -> Any:
        return await fn(self)


def django_executor(db_alias: str = "default") -> DjangoExecutor:
    """Create a SQLExecutor from Django's database connection."""
    return DjangoExecutor(db_alias)


def _convert_params(sql: str, params: list[Any] | None) -> tuple[str, list[Any]]:
    """Convert $1, $2 positional params to %s params for Django's cursor.execute().

    Also handles Postgres type casts like $1::"EnumType" by keeping the cast
    in the SQL and only replacing the placeholder.
    """
    if not params:
        return sql, []

    # Replace $N (with optional ::type cast) with %s (keeping the cast)
    def replacer(match: re.Match[str]) -> str:
        cast = match.group(2) or ""
        return f"%s{cast}"

    converted_sql = re.sub(r'\$(\d+)(::(?:"[^"]+"|[a-zA-Z_]+))?', replacer, sql)
    return converted_sql, list(params)
