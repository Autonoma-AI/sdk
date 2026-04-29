"""Autonoma SDK — Python implementation."""

from autonoma.check import CheckError, CheckResult, check_scenario
from autonoma.factory import define_factory
from autonoma.handler import PROTOCOL_VERSION, handle_request
from autonoma.payload_topo import (
    ResolvedTree,
    compute_teardown_order,
    resolve_payload_tree,
)
from autonoma.schema import build_schema_from_factories, field_type_from_annotation, schema_to_wire
from autonoma.types import (
    AuthContext,
    CreateOp,
    FactoryContext,
    FactoryDefinition,
    FactoryRegistry,
    FieldInfo,
    FKEdge,
    HandlerConfig,
    HandlerRequest,
    HandlerResponse,
    ModelInfo,
    SchemaInfo,
    SchemaRelation,
)

__all__ = [
    # Wire types
    "FieldInfo",
    "ModelInfo",
    "FKEdge",
    "SchemaRelation",
    "SchemaInfo",
    # Host-API types
    "AuthContext",
    "CreateOp",
    "FactoryContext",
    "FactoryDefinition",
    "FactoryRegistry",
    "HandlerConfig",
    "HandlerRequest",
    "HandlerResponse",
    # Handler
    "handle_request",
    "PROTOCOL_VERSION",
    # Factories
    "define_factory",
    # Schema (factory → wire)
    "build_schema_from_factories",
    "field_type_from_annotation",
    "schema_to_wire",
    # Payload topology
    "resolve_payload_tree",
    "compute_teardown_order",
    "ResolvedTree",
    # Check (in-process dry run)
    "check_scenario",
    "CheckResult",
    "CheckError",
]
