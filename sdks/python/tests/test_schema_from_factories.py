"""Tests for ``schema.build_schema_from_factories``."""

import datetime as _dt
import uuid as _uuid

import pytest
from pydantic import BaseModel, ConfigDict

from autonoma.factory import define_factory
from autonoma.schema import (
    build_schema_from_factories,
    field_type_from_annotation,
    schema_to_wire,
)


# ---------------------------------------------------------------------------
# Field type mapping
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "annotation, expected",
    [
        (str, "string"),
        (int, "integer"),
        (bool, "boolean"),
        (float, "number"),
        (_dt.datetime, "timestamp"),
        (_dt.date, "date"),
        (_uuid.UUID, "uuid"),
        (str | None, "string"),  # Optional unwraps to inner type
        (int | None, "integer"),
        (list, "json"),
        (dict, "json"),
    ],
)
def test_field_type_mapping(annotation, expected):
    assert field_type_from_annotation(annotation) == expected


def test_unknown_type_falls_back_to_string():
    class Custom: ...

    assert field_type_from_annotation(Custom) == "string"


# ---------------------------------------------------------------------------
# Schema building
# ---------------------------------------------------------------------------


class OrgInput(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str
    slug: str | None = None


class UserInput(BaseModel):
    model_config = ConfigDict(extra="ignore")
    email: str
    name: str
    organization_id: str
    age: int = 18


def test_emits_one_model_per_factory():
    factories = {
        "Organization": define_factory(create=lambda d, c: {}, input_model=OrgInput),
        "User": define_factory(create=lambda d, c: {}, input_model=UserInput),
    }
    schema = build_schema_from_factories(factories, scope_field="organization_id")

    names = [m.name for m in schema.models]
    assert names == ["Organization", "User"]
    assert schema.scope_field == "organization_id"
    assert schema.edges == []
    assert schema.relations == []


def test_synthetic_id_field_is_first_and_marked_is_id():
    factories = {
        "Organization": define_factory(create=lambda d, c: {}, input_model=OrgInput),
    }
    schema = build_schema_from_factories(factories, scope_field="organization_id")
    fields = schema.models[0].fields
    assert fields[0].name == "id"
    assert fields[0].is_id is True
    assert fields[0].has_default is True


def test_pydantic_field_metadata_propagates():
    factories = {
        "User": define_factory(create=lambda d, c: {}, input_model=UserInput),
    }
    schema = build_schema_from_factories(factories, scope_field="organization_id")
    by_name = {f.name: f for f in schema.models[0].fields}

    assert by_name["email"].type == "string"
    assert by_name["email"].is_required is True
    assert by_name["age"].type == "integer"
    assert by_name["age"].is_required is False
    assert by_name["age"].has_default is True


def test_table_name_is_snake_case_of_model_name():
    factories = {
        "OrgMember": define_factory(create=lambda d, c: {}, input_model=OrgInput),
    }
    schema = build_schema_from_factories(factories, scope_field="organization_id")
    assert schema.models[0].table_name == "org_member"


def test_wire_shape_uses_camel_case_keys():
    factories = {
        "Organization": define_factory(create=lambda d, c: {}, input_model=OrgInput),
    }
    schema = build_schema_from_factories(factories, scope_field="organization_id")
    wire = schema_to_wire(schema)
    field0 = wire["models"][0]["fields"][0]
    # Wire-shape uses camelCase: isRequired / isId / hasDefault / tableName
    assert "isRequired" in field0
    assert "isId" in field0
    assert "hasDefault" in field0
    assert "tableName" in wire["models"][0]
    assert "scopeField" in wire
