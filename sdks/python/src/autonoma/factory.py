"""Factory definition helper for hybrid entity creation."""

from __future__ import annotations

from .types import FactoryDefinition


def define_factory(
    create: ...,
    teardown: ... = None,
) -> FactoryDefinition:
    """Define a factory for creating entities via user code instead of raw SQL.

    The factory's `create` function receives pre-resolved fields (temp IDs replaced
    with real IDs) and must return at least the primary key field.
    """
    if not callable(create):
        raise ValueError('Factory definition must include a callable "create"')
    if teardown is not None and not callable(teardown):
        raise ValueError('Factory "teardown" must be callable if provided')
    return FactoryDefinition(create=create, teardown=teardown)
