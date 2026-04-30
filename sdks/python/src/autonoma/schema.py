"""Build the SDK's wire-shape schema from registered factories.

The dashboard's ``discover`` response carries a ``schema`` block that lists
every model the host can create, along with each model's fields. With the
old SDK that came from ``information_schema`` queries; with this one it
comes from each factory's ``input_model`` (a Pydantic v2 class).

The mapping from a Python type annotation to the dashboard's coarse type
string is intentionally lossy — the dashboard only branches on a handful
of categories (``string``, ``integer``, ``boolean``, ``timestamp``, ...)
and treats everything else as opaque JSON.
"""

from __future__ import annotations

import types as _types
import typing as _typing
from datetime import date, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from autonoma.types import FieldInfo, FKEdge, FactoryRegistry, ModelInfo, SchemaInfo, SchemaRelation


def field_type_from_annotation(annotation: Any) -> str:
    """Map a Pydantic field annotation to the SDK's coarse type string.

    The SDK emits a handful of canonical names (``string``, ``integer``,
    ``number``, ``boolean``, ``timestamp``, ``date``, ``uuid``, ``json``)
    so the dashboard can render appropriate input controls. Unknown
    annotations fall back to ``string`` — the conservative default.
    """
    origin = _typing.get_origin(annotation)

    # Optional[T] / T | None — strip None and recurse on the remaining arg.
    union_origins = {_typing.Union}
    if hasattr(_types, "UnionType"):
        union_origins.add(_types.UnionType)
    if origin in union_origins:
        non_none = [a for a in _typing.get_args(annotation) if a is not type(None)]
        if len(non_none) == 1:
            return field_type_from_annotation(non_none[0])
        return "json"

    if origin in (list, tuple, set, dict, frozenset):
        return "json"

    # Bare collection types (``list``, ``dict``, ...) without parameters
    # arrive with ``origin=None`` but are themselves the type.
    if annotation in (list, tuple, set, dict, frozenset):
        return "json"

    if isinstance(annotation, type):
        # ``bool`` is a subclass of ``int``; check it first.
        if issubclass(annotation, bool):
            return "boolean"
        if issubclass(annotation, int):
            return "integer"
        if issubclass(annotation, (float, Decimal)):
            return "number"
        if issubclass(annotation, datetime):
            return "timestamp"
        if issubclass(annotation, date):
            return "date"
        if issubclass(annotation, UUID):
            return "uuid"
        if issubclass(annotation, str):
            return "string"

    return "string"


def _camel_to_snake(name: str) -> str:
    """Convert ``OrgMember`` to ``org_member`` for cosmetic ``tableName``."""
    out: list[str] = []
    for i, ch in enumerate(name):
        if ch.isupper() and i > 0 and not name[i - 1].isupper():
            out.append("_")
        out.append(ch.lower())
    return "".join(out)


def _model_to_fields(input_model: Any) -> list[FieldInfo]:
    """Walk a Pydantic v2 model's ``model_fields`` to a list of ``FieldInfo``.

    Every model gets a synthetic ``id`` field at the head of the list
    because factories always mint a primary key, even though it isn't
    declared on the input model (factories receive resolved input and
    produce a record that includes ``id``).
    """
    try:
        from pydantic_core import PydanticUndefined  # type: ignore
    except ImportError:  # pragma: no cover — pydantic is a hard dep
        PydanticUndefined = object()  # type: ignore

    fields: list[FieldInfo] = [
        FieldInfo(
            name="id",
            type="string",
            is_required=False,
            is_id=True,
            has_default=True,
        ),
    ]

    model_fields = getattr(input_model, "model_fields", None)
    if not model_fields:
        return fields

    for fname, finfo in model_fields.items():
        has_default = (
            getattr(finfo, "default", PydanticUndefined) is not PydanticUndefined
            or getattr(finfo, "default_factory", None) is not None
        )
        is_required = bool(finfo.is_required()) if hasattr(finfo, "is_required") else not has_default
        fields.append(
            FieldInfo(
                name=fname,
                type=field_type_from_annotation(getattr(finfo, "annotation", None)),
                is_required=is_required,
                is_id=False,
                has_default=has_default,
            )
        )
    return fields


def build_schema_from_factories(factories: FactoryRegistry, scope_field: str) -> SchemaInfo:
    """Build the SDK's discover-time schema from registered factories.

    ``edges`` and ``relations`` are emitted as empty lists. They were
    populated from FK introspection in the old design; here the create
    payload's ``_alias`` / ``_ref`` graph carries equivalent information
    at request time, so the static schema doesn't need them.
    """
    models: list[ModelInfo] = []
    for entity, factory in factories.items():
        if factory.input_model is None:
            raise ValueError(
                f'Factory "{entity}" has no input_model. '
                "Every factory must declare a Pydantic model in `define_factory(..., input_model=...)`."
            )
        models.append(
            ModelInfo(
                name=entity,
                table_name=_camel_to_snake(entity),
                fields=_model_to_fields(factory.input_model),
            )
        )

    return SchemaInfo(
        models=models,
        edges=[],
        relations=[],
        scope_field=scope_field,
    )


def schema_to_wire(schema: SchemaInfo) -> dict[str, Any]:
    """Serialise a ``SchemaInfo`` to the JSON shape the dashboard expects.

    Field names in the wire JSON are camelCase, e.g. ``isRequired`` not
    ``is_required``. Kept here next to ``build_schema_from_factories`` so
    both sides of the discover response live in one place.
    """
    return {
        "models": [
            {
                "name": m.name,
                "tableName": m.table_name,
                "fields": [
                    {
                        "name": f.name,
                        "type": f.type,
                        "isRequired": f.is_required,
                        "isId": f.is_id,
                        "hasDefault": f.has_default,
                    }
                    for f in m.fields
                ],
            }
            for m in schema.models
        ],
        "edges": [
            {
                "from": e.from_model,
                "to": e.to_model,
                "localField": e.local_field,
                "foreignField": e.foreign_field,
                "nullable": e.nullable,
            }
            for e in schema.edges
        ],
        "relations": [
            {
                "parentModel": r.parent_model,
                "childModel": r.child_model,
                "parentField": r.parent_field,
                "childField": r.child_field,
            }
            for r in schema.relations
        ],
        "scopeField": schema.scope_field,
    }


# Keep the empty-list builders re-exportable for symmetry with the wire types.
__all__ = [
    "FKEdge",
    "SchemaRelation",
    "build_schema_from_factories",
    "field_type_from_annotation",
    "schema_to_wire",
]
