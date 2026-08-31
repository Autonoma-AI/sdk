"""Define a named scenario.

A scenario's ``up`` is free-form async (or sync) code - loops, conditionals,
real API calls - that provisions an isolated environment and returns the
``auth``/``teardown`` a test run needs. An omitted ``down`` is a no-op.
Register scenarios with ``HandlerConfig(scenarios=[define_scenario(...)])``.

Example::

    define_scenario(
        name="single-user",
        description="One verified user in a fresh org",
        up=lambda ctx: {
            "auth": {"headers": {"Authorization": f"Bearer {mint(ctx.test_run_id)}"}},
            "teardown": {"user_id": create_user(ctx.test_run_id)},
        },
        down=lambda ctx: delete_user(ctx.teardown["user_id"]),
    )
"""

from __future__ import annotations

from autonoma.types import ScenarioDefinition, ScenarioDown, ScenarioUp


def define_scenario(
    name: str,
    description: str,
    up: ScenarioUp,
    down: ScenarioDown | None = None,
) -> ScenarioDefinition:
    """Define a scenario for an isolated test environment."""
    if not isinstance(name, str) or not name:
        raise ValueError('Scenario "name" must be a non-empty string')
    if not isinstance(description, str):
        raise ValueError('Scenario "description" must be a string')
    if not callable(up):
        raise ValueError('Scenario "up" must be callable')
    if down is not None and not callable(down):
        raise ValueError('Scenario "down" must be callable if provided')
    return ScenarioDefinition(name=name, description=description, up=up, down=down)
