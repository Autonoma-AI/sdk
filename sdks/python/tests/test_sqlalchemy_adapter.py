"""Tests for the SQLAlchemy ORM adapter."""

from __future__ import annotations

import pytest
from sqlalchemy import Column, ForeignKey, String, create_engine
from sqlalchemy.orm import declarative_base, relationship, sessionmaker

from autonoma_sqlalchemy import SQLAlchemyAdapter

Base = declarative_base()


class Organization(Base):
    __tablename__ = "organizations"
    id = Column(String, primary_key=True)
    name = Column(String, nullable=False)
    users = relationship("User", back_populates="organization")
    applications = relationship("Application", back_populates="organization")


class User(Base):
    __tablename__ = "users"
    id = Column(String, primary_key=True)
    email = Column(String, nullable=False)
    organization_id = Column(String, ForeignKey("organizations.id"), nullable=False)
    organization = relationship("Organization", back_populates="users")


class Application(Base):
    __tablename__ = "applications"
    id = Column(String, primary_key=True)
    name = Column(String, nullable=False)
    organization_id = Column(String, ForeignKey("organizations.id"), nullable=False)
    organization = relationship("Organization", back_populates="applications")


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    yield Session
    engine.dispose()


@pytest.fixture
def adapter(db_session):
    return SQLAlchemyAdapter(
        db_session,
        [Organization, User, Application],
        scope_field="organization_id",
    )


def test_get_schema_models(adapter):
    schema = adapter.get_schema()
    model_names = {m["name"] for m in schema["models"]}
    assert model_names == {"Organization", "User", "Application"}


def test_get_schema_fields(adapter):
    schema = adapter.get_schema()
    user_model = next(m for m in schema["models"] if m["name"] == "User")
    field_names = {f["name"] for f in user_model["fields"]}
    assert "id" in field_names
    assert "email" in field_names
    assert "organization_id" in field_names


def test_get_schema_edges(adapter):
    schema = adapter.get_schema()
    assert len(schema["edges"]) == 2  # User->Org and Application->Org
    edge_pairs = {(e["from"], e["to"]) for e in schema["edges"]}
    assert ("User", "Organization") in edge_pairs
    assert ("Application", "Organization") in edge_pairs


def test_get_schema_scope_field(adapter):
    schema = adapter.get_schema()
    assert schema["scopeField"] == "organization_id"


@pytest.mark.asyncio
async def test_create_entities(adapter, db_session):
    spec = {
        "Organization": {"fields": [{"id": "org-1", "name": "Test Org"}]},
        "User": {"fields": [{"id": "user-1", "email": "test@test.com", "organization_id": "org-1"}]},
    }
    results = await adapter.create_entities(spec, {"testRunId": "test-1"})

    assert "Organization" in results
    assert results["Organization"][0]["id"] == "org-1"
    assert "User" in results
    assert results["User"][0]["email"] == "test@test.com"

    # Verify actually in DB
    session = db_session()
    assert session.query(Organization).count() == 1
    assert session.query(User).count() == 1
    session.close()


@pytest.mark.asyncio
async def test_teardown(adapter, db_session):
    # Create data first
    spec = {
        "Organization": {"fields": [{"id": "org-1", "name": "Test Org"}]},
        "User": {"fields": [{"id": "user-1", "email": "a@b.com", "organization_id": "org-1"}]},
        "Application": {"fields": [{"id": "app-1", "name": "App", "organization_id": "org-1"}]},
    }
    await adapter.create_entities(spec, {})

    # Verify data exists
    session = db_session()
    assert session.query(Organization).count() == 1
    assert session.query(User).count() == 1
    assert session.query(Application).count() == 1
    session.close()

    # Teardown
    await adapter.teardown("org-1")

    # Verify all gone
    session = db_session()
    assert session.query(Organization).count() == 0
    assert session.query(User).count() == 0
    assert session.query(Application).count() == 0
    session.close()


@pytest.mark.asyncio
async def test_full_roundtrip(adapter, db_session):
    """Full round-trip: introspect → create → verify → teardown → verify gone."""
    schema = adapter.get_schema()
    assert len(schema["models"]) == 3

    spec = {
        "Organization": {"fields": [{"id": "org-rt", "name": "Roundtrip Org"}]},
        "User": {"fields": [
            {"id": "u1", "email": "u1@test.com", "organization_id": "org-rt"},
            {"id": "u2", "email": "u2@test.com", "organization_id": "org-rt"},
        ]},
        "Application": {"fields": [{"id": "a1", "name": "MyApp", "organization_id": "org-rt"}]},
    }
    refs = await adapter.create_entities(spec, {})

    session = db_session()
    assert session.query(Organization).count() == 1
    assert session.query(User).count() == 2
    assert session.query(Application).count() == 1
    session.close()

    await adapter.teardown("org-rt", refs)

    session = db_session()
    assert session.query(Organization).count() == 0
    assert session.query(User).count() == 0
    assert session.query(Application).count() == 0
    session.close()
