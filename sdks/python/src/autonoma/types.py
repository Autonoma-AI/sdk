"""Type definitions for Autonoma SDK.

The SDK is factory-driven: every model is owned by a registered factory whose
input is described by a Pydantic v2 model. There is no SQL introspection, no
executor protocol, and no dialect machinery — those concepts belonged to an
earlier design where the SDK reached into the host database directly.

The types in this module fall into two groups:

* **Wire-shape types** (``SchemaInfo``, ``ModelInfo``, ``FieldInfo``,
  ``FKEdge``, ``SchemaRelation``) — the JSON the SDK emits in
  ``discover``/``up``/``down`` responses. ``FKEdge`` and ``SchemaRelation``
  are kept because the dashboard tolerates them as empty arrays; emitting
  them keeps the wire format bit-identical to v1.

* **Host-API types** (``HandlerConfig``, ``FactoryDefinition``,
  ``FactoryContext``) — what host code touches when wiring up the SDK.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass, field
from typing import Any, Callable, Union


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
    """Wire-shape only. Always emitted as an empty list in factory-driven
    setups — the alias/_ref graph carried by the create payload is the
    real dependency information."""

    from_model: str
    to_model: str
    local_field: str
    foreign_field: str
    nullable: bool


@dataclass
class SchemaRelation:
    """Wire-shape only — same rationale as ``FKEdge``."""

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
class HookContext:
    """Context passed to handler hooks."""

    scenario_name: str
    refs: dict[str, list[dict[str, Any]]]


@dataclass
class AuthContext:
    """Context passed to the auth callback alongside the user record."""

    scope_value: str
    refs: dict[str, list[dict[str, Any]]]


@dataclass
class FactoryContext:
    """Context passed to factory create/teardown functions.

    Factories that need a database connection get it from the host (their
    own SQLAlchemy session, Django ORM, etc.) — the SDK does not ship
    one. ``refs`` and ``test_run_id`` are the only things the SDK can
    legitimately add.
    """

    refs: dict[str, list[dict[str, Any]]]
    scenario_name: str
    test_run_id: str


@dataclass
class FactoryDefinition:
    """A factory for creating entities via user code.

    ``input_model`` is **required**: the SDK validates the resolved field
    dict through ``input_model.model_validate(fields)`` before invoking
    ``create``, and uses the same model to build the discover schema.
    ``ref_model`` is optional; when provided, the SDK validates the
    stored record through ``ref_model.model_validate(record)`` before
    invoking ``teardown``.

    The SDK relies only on the Pydantic v2-style ``model_validate`` /
    ``model_dump`` protocol — any class exposing those methods works,
    though Pydantic v2 is the supported reference.
    """

    create: Callable[..., Any]
    input_model: Any
    teardown: Callable[..., Any] | None = None
    ref_model: Any = None


FactoryRegistry = dict[str, FactoryDefinition]


@dataclass
class HandlerConfig:
    """Configuration for the Autonoma request handler."""

    scope_field: str
    shared_secret: str
    signing_secret: str
    auth: Union[
        Callable[[dict[str, Any] | None, AuthContext], dict[str, Any]],
        Callable[[dict[str, Any] | None, AuthContext], Any],  # async callables
    ]
    factories: FactoryRegistry = field(default_factory=dict)
    # Deprecated - ignored; the endpoint is always enabled and HMAC signing is
    # the gate. On Autonoma previews (AUTONOMA_PREVIEWKIT set) no guard is
    # needed; gate manually in your handler for your own production deployments.
    allow_production: bool = False
    sdk: dict[str, str] | None = None
    before_down: Callable[[HookContext], Any] | None = None
    after_up: Callable[[HookContext, dict[str, Any]], dict[str, Any]] | None = None

    def __post_init__(self) -> None:
        if self.allow_production:
            warnings.warn(
                "allow_production is deprecated and ignored - the endpoint is always enabled",
                DeprecationWarning,
                stacklevel=2,
            )


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
    """A create operation produced by the payload topo resolver."""

    model: str
    fields: dict[str, Any]
    temp_id: str
