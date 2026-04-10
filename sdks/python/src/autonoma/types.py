"""Type definitions for Autonoma SDK."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Protocol, runtime_checkable


@dataclass
class FieldInfo:
    name: str
    type: str
    is_required: bool
    is_id: bool
    has_default: bool


@dataclass
class ModelInfo:
    name: str
    table_name: str
    fields: list[FieldInfo]


@dataclass
class FKEdge:
    from_model: str
    to_model: str
    local_field: str
    foreign_field: str
    nullable: bool


@dataclass
class SchemaRelation:
    parent_model: str
    child_model: str
    parent_field: str
    child_field: str


@dataclass
class SchemaInfo:
    models: list[ModelInfo]
    edges: list[FKEdge]
    relations: list[SchemaRelation]
    scope_field: str


@runtime_checkable
class SQLExecutor(Protocol):
    """Minimal SQL executor — wrap your DB connection (pg Pool, SQLAlchemy, etc.) into this."""

    async def query(self, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]: ...

    async def transaction(self, fn: Callable[..., Any]) -> Any: ...


@dataclass
class HandlerConfig:
    """Configuration for the Autonoma request handler."""
    executor: SQLExecutor
    scope_field: str
    shared_secret: str
    signing_secret: str
    auth: Callable[[dict[str, Any] | None], dict[str, Any]]
    dialect: str = "postgres"
    db_schema: str | None = None
    table_name_map: dict[str, str] | None = None
    exclude_tables: list[str] | None = None
    allow_production: bool = False
    sdk: dict[str, str] | None = None


@dataclass
class HandlerRequest:
    body: str
    headers: dict[str, str] = field(default_factory=dict)


@dataclass
class HandlerResponse:
    status: int
    body: dict[str, Any]


@dataclass
class CreateOp:
    """A create operation produced by the tree resolver."""
    model: str
    fields: dict[str, Any]
    temp_id: str
    batch: bool


@dataclass
class DeferredUpdate:
    """A deferred FK update for circular dependencies."""
    target_temp_id: str
    model: str
    field: str
    ref_alias: str


@dataclass
class IntrospectionResult:
    """Result of database introspection."""
    schema: SchemaInfo
    table_map: dict[str, str]
    column_maps: dict[str, dict[str, str]]
    enum_type_maps: dict[str, dict[str, str]]
