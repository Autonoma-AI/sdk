"""Autonoma SDK - Python implementation (Scenario v2)."""

from autonoma.check import CheckError, CheckResult, check_scenario
from autonoma.errors import AutonomaError
from autonoma.factory import define_factory
from autonoma.handler import PROTOCOL_VERSION, handle_request
from autonoma.payload_topo import (
    ResolvedTree,
    compute_teardown_order,
    resolve_payload_tree,
)
from autonoma.scenario import define_scenario
from autonoma.types import (
    CreateOp,
    FactoryContext,
    FactoryDefinition,
    FactoryRegistry,
    HandlerConfig,
    HandlerRequest,
    HandlerResponse,
    ScenarioDefinition,
    ScenarioDownContext,
    ScenarioUpContext,
    ScenarioUpResult,
)
from autonoma.unique import unique_email, unique_id, unique_slug, unique_token

__all__ = [
    # Scenario authoring surface
    "define_scenario",
    "ScenarioDefinition",
    "ScenarioUpContext",
    "ScenarioUpResult",
    "ScenarioDownContext",
    # Handler
    "handle_request",
    "PROTOCOL_VERSION",
    "HandlerConfig",
    "HandlerRequest",
    "HandlerResponse",
    # uniqueness helpers
    "unique_token",
    "unique_id",
    "unique_slug",
    "unique_email",
    # Errors
    "AutonomaError",
    # Check (in-process dry run)
    "check_scenario",
    "CheckResult",
    "CheckError",
    # Optional factory library (not wired to the wire protocol)
    "define_factory",
    "FactoryContext",
    "FactoryDefinition",
    "FactoryRegistry",
    "resolve_payload_tree",
    "compute_teardown_order",
    "ResolvedTree",
    "CreateOp",
]
