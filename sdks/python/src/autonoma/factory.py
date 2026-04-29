"""Factory definition helper.

The SDK is factory-driven: every model the dashboard can create is owned
by a registered factory. ``input_model`` is **required** — it is what the
SDK uses to validate inputs before calling ``create`` and to populate the
discover schema, replacing the SQL introspection that earlier versions
relied on.
"""

from __future__ import annotations

from autonoma.types import FactoryDefinition


def define_factory(
    create,
    input_model,
    teardown=None,
    ref_model=None,
) -> FactoryDefinition:
    """Define a factory for an entity.

    The factory's ``create`` function receives a validated instance of
    ``input_model`` (a Pydantic v2 class) and a :class:`FactoryContext`,
    and must return a record dict that includes at least ``id``. The SDK
    handles ``_alias`` / ``_ref`` resolution before calling ``create`` —
    the data the function sees has temp ids already swapped for real
    ids.

    ``input_model`` is required because the SDK derives the discover
    schema from it (no DB introspection). Pass any Pydantic v2 class:
    setting ``model_config = ConfigDict(extra="ignore")`` is recommended
    so recipe-only metadata doesn't trip validation.

    ``teardown`` is optional but strongly recommended; without it the
    SDK has no way to remove rows the factory created, since the SDK no
    longer issues raw SQL. ``ref_model`` is optional — if provided, the
    SDK validates the stored record through it before calling
    ``teardown``.
    """
    if not callable(create):
        raise ValueError('Factory definition must include a callable "create"')
    if teardown is not None and not callable(teardown):
        raise ValueError('Factory "teardown" must be callable if provided')
    if input_model is None:
        raise ValueError(
            'Factory must declare `input_model=...`. The SDK derives the discover '
            'schema from it; there is no automatic fallback.'
        )
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
