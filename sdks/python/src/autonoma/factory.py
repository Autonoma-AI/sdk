"""Factory definition helper for hybrid entity creation."""

from __future__ import annotations

from .types import FactoryDefinition


def define_factory(
    create: ...,
    teardown: ... = None,
    input_model: ... = None,
    ref_model: ... = None,
) -> FactoryDefinition:
    """Define a factory for creating entities via user code instead of raw SQL.

    The factory's ``create`` function receives pre-resolved fields (temp IDs
    replaced with real IDs) and must return at least the primary key field.

    Optional ``input_model`` / ``ref_model`` parameters opt the factory into a
    typed contract: the SDK calls ``input_model.model_validate(fields)`` before
    invoking ``create``, and ``ref_model.model_validate(record)`` before
    invoking ``teardown``. The SDK relies only on the Pydantic v2-style
    ``model_validate`` / ``model_dump`` protocol — any class exposing those
    methods is accepted.
    """
    if not callable(create):
        raise ValueError('Factory definition must include a callable "create"')
    if teardown is not None and not callable(teardown):
        raise ValueError('Factory "teardown" must be callable if provided')
    for name, model in (("input_model", input_model), ("ref_model", ref_model)):
        if model is not None and not hasattr(model, "model_validate"):
            raise ValueError(
                f'Factory "{name}" must expose `model_validate` (e.g. a Pydantic v2 model)'
            )
    return FactoryDefinition(
        create=create,
        teardown=teardown,
        input_model=input_model,
        ref_model=ref_model,
    )
