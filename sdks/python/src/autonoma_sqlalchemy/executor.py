"""SQLAlchemy SQLExecutor wrapper — thin adapter for the SQL-first architecture."""

from __future__ import annotations

import re
from typing import Any, Callable


class SQLAlchemyExecutor:
    """Wraps a SQLAlchemy engine as a SQLExecutor.

    Usage::

        from sqlalchemy import create_engine
        from autonoma_sqlalchemy.executor import sqlalchemy_executor

        engine = create_engine("postgresql://...")
        executor = sqlalchemy_executor(engine)
    """

    def __init__(self, engine: Any) -> None:
        self._engine = engine

    async def query(self, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
        from sqlalchemy import text
        sa_sql, sa_params = _convert_params(sql, params)
        with self._engine.connect() as conn:
            result = conn.execute(text(sa_sql), sa_params)
            try:
                rows = result.fetchall()
                columns = list(result.keys())
                return [dict(zip(columns, row)) for row in rows]
            except Exception:
                conn.commit()
                return []

    async def transaction(self, fn: Callable[..., Any]) -> Any:
        with self._engine.begin() as conn:
            tx_executor = _TxExecutor(conn)
            return await fn(tx_executor)


class _TxExecutor:
    """SQLExecutor scoped to an active transaction."""

    def __init__(self, conn: Any) -> None:
        self._conn = conn

    async def query(self, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
        from sqlalchemy import text
        sa_sql, sa_params = _convert_params(sql, params)
        result = self._conn.execute(text(sa_sql), sa_params)
        try:
            rows = result.fetchall()
            columns = list(result.keys())
            return [dict(zip(columns, row)) for row in rows]
        except Exception:
            return []

    async def transaction(self, fn: Any) -> Any:
        return await fn(self)


def sqlalchemy_executor(engine: Any) -> SQLAlchemyExecutor:
    """Create a SQLExecutor from a SQLAlchemy engine."""
    return SQLAlchemyExecutor(engine)


def _convert_params(sql: str, params: list[Any] | None) -> tuple[str, dict[str, Any]]:
    """Convert $1, $2 positional params to :p1, :p2 named params for SQLAlchemy text().

    Also handles Postgres type casts like $1::"EnumType" → :p1\\:\\:"EnumType"
    by keeping the cast in the SQL and only replacing the placeholder.
    """
    if not params:
        return sql, {}

    param_dict: dict[str, Any] = {}
    for i, val in enumerate(params, 1):
        param_dict[f"p{i}"] = val

    # Replace $N (with optional ::type cast) with :pN (keeping the cast)
    def replacer(match: re.Match[str]) -> str:
        idx = match.group(1)
        cast = match.group(2) or ""
        return f":p{idx}{cast}"

    converted_sql = re.sub(r'\$(\d+)(::(?:"[^"]+"|[a-zA-Z_]+))?', replacer, sql)
    return converted_sql, param_dict
