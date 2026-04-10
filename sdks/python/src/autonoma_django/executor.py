"""Django SQLExecutor wrapper — thin adapter for the SQL-first architecture."""

from __future__ import annotations

import re
from typing import Any, Callable


class DjangoExecutor:
    """Wraps Django's database connection as a SQLExecutor.

    Uses ``sync_to_async`` so that synchronous Django DB calls are safe to
    invoke from both WSGI (via ``asyncio.run``) and ASGI contexts.

    Usage::

        from autonoma_django.executor import django_executor

        executor = django_executor()
        # or with a specific database alias:
        executor = django_executor("secondary")
    """

    def __init__(self, db_alias: str = "default") -> None:
        self._db_alias = db_alias

    async def query(self, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
        from asgiref.sync import sync_to_async
        return await sync_to_async(self._query_sync)(sql, params)

    def _query_sync(self, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
        from django.db import connections

        conn = connections[self._db_alias]
        dj_sql, dj_params = _convert_params(sql, params)

        with conn.cursor() as cursor:
            cursor.execute(dj_sql, dj_params)
            try:
                columns = [col[0] for col in cursor.description]
                rows = cursor.fetchall()
                return [dict(zip(columns, row)) for row in rows]
            except Exception:
                return []

    async def transaction(self, fn: Callable[..., Any]) -> Any:
        from asgiref.sync import sync_to_async
        from django.db import transaction as dj_tx

        atomic = dj_tx.atomic(using=self._db_alias)
        await sync_to_async(atomic.__enter__)()

        try:
            tx_executor = _TxExecutor(self._db_alias)
            result = await fn(tx_executor)
        except BaseException as exc:
            await sync_to_async(atomic.__exit__)(type(exc), exc, exc.__traceback__)
            raise
        else:
            await sync_to_async(atomic.__exit__)(None, None, None)
            return result


class _TxExecutor:
    """SQLExecutor scoped to an active Django atomic block."""

    def __init__(self, db_alias: str) -> None:
        self._db_alias = db_alias

    def _query_sync(self, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
        from django.db import connections

        conn = connections[self._db_alias]
        dj_sql, dj_params = _convert_params(sql, params)

        with conn.cursor() as cursor:
            cursor.execute(dj_sql, dj_params)
            try:
                columns = [col[0] for col in cursor.description]
                rows = cursor.fetchall()
                return [dict(zip(columns, row)) for row in rows]
            except Exception:
                return []

    async def query(self, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
        from asgiref.sync import sync_to_async
        return await sync_to_async(self._query_sync)(sql, params)

    async def transaction(self, fn: Any) -> Any:
        return await fn(self)


def django_executor(db_alias: str = "default") -> DjangoExecutor:
    """Create a SQLExecutor from Django's database connection."""
    return DjangoExecutor(db_alias)


def _convert_params(sql: str, params: list[Any] | None) -> tuple[str, list[Any]]:
    """Convert positional params to ``%s`` params for Django's ``cursor.execute()``.

    Handles both Postgres-style ``$1, $2`` placeholders and MySQL-style ``?``
    placeholders. Also preserves Postgres type casts like ``$1::"EnumType"``.
    """
    if not params:
        return sql, []

    # First: replace $N (with optional ::type cast) with %s (keeping the cast)
    def replacer(match: re.Match[str]) -> str:
        cast = match.group(2) or ""
        return f"%s{cast}"

    converted_sql = re.sub(r'\$(\d+)(::(?:"[^"]+"|[a-zA-Z_]+))?', replacer, sql)

    # Second: replace MySQL-style ? placeholders with %s
    converted_sql = converted_sql.replace("?", "%s")

    return converted_sql, list(params)
