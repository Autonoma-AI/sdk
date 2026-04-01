"""Type definitions for Autonoma SDK."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Optional, Protocol, runtime_checkable


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


@dataclass
class HandlerConfig:
    adapter: OrmAdapter
    shared_secret: str
    signing_secret: str
    allow_production: bool = False
    auth: Optional[Callable[[dict[str, Any]], dict[str, Any]]] = None


@dataclass
class HandlerRequest:
    body: str
    headers: dict[str, str] = field(default_factory=dict)


@dataclass
class HandlerResponse:
    status: int
    body: dict[str, Any]


@runtime_checkable
class OrmAdapter(Protocol):
    def get_schema(self) -> dict[str, Any]: ...
    async def create_entities(self, spec: dict[str, Any], context: dict[str, Any]) -> dict[str, list[dict[str, Any]]]: ...
    async def teardown(self, scope_value: str, refs: Optional[dict[str, Any]] = None) -> None: ...
