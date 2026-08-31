"""Type definitions for the Autonoma SDK (Scenario v2).

A customer authors named **scenarios** with :func:`autonoma.define_scenario`.
The platform calls ``up`` with only a scenario name + ``testRunId``; the
scenario's ``up`` runs free-form async code and returns optional
``auth``/``teardown``. The SDK owns the envelope: ``teardownToken`` signing,
expiry defaults, and the protocol ``version`` field.

``FactoryDefinition``/``FactoryContext`` below survive as an optional library
a scenario's ``up``/``down`` may use internally (see :mod:`autonoma.factory`);
they are no longer wired to the wire protocol.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass, field
from typing import Any, Callable


# ---------------------------------------------------------------------------
# Scenario authoring surface
# ---------------------------------------------------------------------------


@dataclass
class ScenarioUpContext:
    """Context passed to a scenario's ``up``."""

    test_run_id: str


@dataclass
class ScenarioUpResult:
    """What a scenario's ``up`` returns. All fields optional.

    ``auth`` holds credentials; ``teardown`` is any JSON handle needed for
    teardown.
    """

    auth: dict[str, Any] | None = None
    teardown: dict[str, Any] | None = None


@dataclass
class ScenarioDownContext:
    """Context passed to a scenario's ``down``."""

    name: str
    teardown: dict[str, Any]
    test_run_id: str


# A scenario's ``up`` may return a ``ScenarioUpResult`` or a plain dict with
# ``auth``/``teardown`` keys; both sync and async are accepted.
ScenarioUp = Callable[[ScenarioUpContext], Any]
ScenarioDown = Callable[[ScenarioDownContext], Any]


@dataclass
class ScenarioDefinition:
    """A named scenario.

    ``up`` provisions an isolated environment a test needs; the optional
    ``down`` tears it back down. Register with
    ``HandlerConfig(scenarios=[define_scenario(...)])``.
    """

    name: str
    description: str
    up: ScenarioUp
    down: ScenarioDown | None = None


# ---------------------------------------------------------------------------
# Optional factory library (not wired to the wire protocol in v2)
# ---------------------------------------------------------------------------


@dataclass
class FactoryContext:
    """Context passed to factory create/teardown functions.

    Factories that need a database connection get it from the host (their
    own SQLAlchemy session, Django ORM, etc.) - the SDK does not ship one.
    """

    refs: dict[str, list[dict[str, Any]]]
    scenario_name: str
    test_run_id: str


@dataclass
class FactoryDefinition:
    """A factory for creating entities via user code.

    ``input_model`` is a Pydantic v2 class used to validate the create input.
    ``ref_model`` is optional; when provided, the SDK validates the stored
    record through it before calling ``teardown``.
    """

    create: Callable[..., Any]
    input_model: Any
    teardown: Callable[..., Any] | None = None
    ref_model: Any = None


FactoryRegistry = dict[str, FactoryDefinition]


# ---------------------------------------------------------------------------
# Handler config + wire types
# ---------------------------------------------------------------------------


@dataclass
class HandlerConfig:
    """Configuration for the Autonoma request handler."""

    shared_secret: str
    signing_secret: str
    scenarios: list[ScenarioDefinition] = field(default_factory=list)
    # Token/environment lifetime returned on ``up`` as ``expiresInSeconds``.
    # Defaults to one hour when None.
    expires_in_seconds: int | None = None
    # Deprecated - ignored; the endpoint is always enabled and HMAC signing is
    # the gate. Gate manually in your handler for your own production deploys.
    allow_production: bool = False
    sdk: dict[str, str] | None = None

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
    """A create operation produced by the optional payload topo resolver."""

    model: str
    fields: dict[str, Any]
    temp_id: str
