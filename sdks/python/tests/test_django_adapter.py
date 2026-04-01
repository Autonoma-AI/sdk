"""Tests for the Django ORM adapter and view handler."""

from __future__ import annotations

import json

import django
from django.conf import settings

# Configure Django before anything else
import os
import tempfile

# Allow sync Django ORM calls from async test functions
os.environ["DJANGO_ALLOW_ASYNC_UNSAFE"] = "true"

_db_file = os.path.join(tempfile.gettempdir(), "autonoma_django_test.db")

if not settings.configured:
    settings.configure(
        DATABASES={"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": _db_file}},
        INSTALLED_APPS=["django.contrib.contenttypes", "django.contrib.auth"],
        DEFAULT_AUTO_FIELD="django.db.models.BigAutoField",
        ROOT_URLCONF=__name__,
    )
    django.setup()

import pytest
from django.db import connection, models
from django.test import RequestFactory

from autonoma.hmac_util import sign_body
from autonoma.refs import sign_refs
from autonoma.types import HandlerConfig


# ---------------------------------------------------------------------------
# Test models
# ---------------------------------------------------------------------------

class Organization(models.Model):
    id = models.CharField(max_length=255, primary_key=True)
    name = models.CharField(max_length=255)

    class Meta:
        app_label = "tests"
        db_table = "test_organizations"


class User(models.Model):
    id = models.CharField(max_length=255, primary_key=True)
    email = models.CharField(max_length=255)
    organization = models.ForeignKey(Organization, on_delete=models.CASCADE)

    class Meta:
        app_label = "tests"
        db_table = "test_users"


class Application(models.Model):
    id = models.CharField(max_length=255, primary_key=True)
    name = models.CharField(max_length=255)
    organization = models.ForeignKey(Organization, on_delete=models.CASCADE)

    class Meta:
        app_label = "tests"
        db_table = "test_applications"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True, scope="session")
def create_tables():
    """Create tables once for the whole test session using a file-based SQLite DB."""
    with connection.schema_editor() as editor:
        try:
            editor.create_model(Organization)
        except Exception:
            pass
        try:
            editor.create_model(User)
        except Exception:
            pass
        try:
            editor.create_model(Application)
        except Exception:
            pass
    yield
    # Clean up the temp DB file
    try:
        os.unlink(_db_file)
    except OSError:
        pass


@pytest.fixture(autouse=True)
def clean_tables():
    """Clean tables before each test."""
    yield
    Application.objects.all().delete()
    User.objects.all().delete()
    Organization.objects.all().delete()


@pytest.fixture
def adapter():
    from autonoma_django import DjangoAdapter
    return DjangoAdapter([Organization, User, Application], scope_field="organization_id")


# ---------------------------------------------------------------------------
# ORM Adapter Tests
# ---------------------------------------------------------------------------

def test_get_schema_models(adapter):
    schema = adapter.get_schema()
    model_names = {m["name"] for m in schema["models"]}
    assert model_names == {"Organization", "User", "Application"}


def test_get_schema_edges(adapter):
    schema = adapter.get_schema()
    edge_pairs = {(e["from"], e["to"]) for e in schema["edges"]}
    assert ("User", "Organization") in edge_pairs
    assert ("Application", "Organization") in edge_pairs


def test_get_schema_scope_field(adapter):
    schema = adapter.get_schema()
    assert schema["scopeField"] == "organization_id"


@pytest.mark.asyncio
async def test_create_entities(adapter):
    spec = {
        "Organization": {"fields": [{"id": "org-1", "name": "Test Org"}]},
        "User": {"fields": [{"id": "user-1", "email": "test@test.com", "organization_id": "org-1"}]},
    }
    results = await adapter.create_entities(spec, {})

    assert "Organization" in results
    assert results["Organization"][0]["id"] == "org-1"
    assert "User" in results
    assert results["User"][0]["email"] == "test@test.com"

    # Verify in DB
    assert Organization.objects.count() == 1
    assert User.objects.count() == 1


@pytest.mark.asyncio
async def test_teardown(adapter):
    spec = {
        "Organization": {"fields": [{"id": "org-1", "name": "Test Org"}]},
        "User": {"fields": [{"id": "u1", "email": "a@b.com", "organization_id": "org-1"}]},
        "Application": {"fields": [{"id": "a1", "name": "App", "organization_id": "org-1"}]},
    }
    await adapter.create_entities(spec, {})

    assert Organization.objects.count() == 1
    assert User.objects.count() == 1
    assert Application.objects.count() == 1

    await adapter.teardown("org-1")

    assert Organization.objects.count() == 0
    assert User.objects.count() == 0
    assert Application.objects.count() == 0


# ---------------------------------------------------------------------------
# View Handler Tests
# ---------------------------------------------------------------------------

SHARED_SECRET = "test-shared-secret-1234"
SIGNING_SECRET = "test-signing-secret-5678"


@pytest.fixture
def handler_view(adapter):
    from autonoma_django import create_django_handler
    config = HandlerConfig(
        adapter=adapter,
        shared_secret=SHARED_SECRET,
        signing_secret=SIGNING_SECRET,
    )
    return create_django_handler(config)


def test_view_discover(handler_view):
    factory = RequestFactory()
    body = json.dumps({"action": "discover"})
    sig = sign_body(body, SHARED_SECRET)
    request = factory.post(
        "/api/autonoma/",
        data=body,
        content_type="application/json",
        HTTP_X_SIGNATURE=sig,
    )
    response = handler_view(request)
    data = json.loads(response.content)

    assert response.status_code == 200
    assert data["sdk"]["server"] == "django"
    assert data["sdk"]["language"] == "python"
    assert "models" in data["schema"]


def test_view_rejects_invalid_signature(handler_view):
    factory = RequestFactory()
    body = json.dumps({"action": "discover"})
    request = factory.post(
        "/api/autonoma/",
        data=body,
        content_type="application/json",
        HTTP_X_SIGNATURE="bad-sig",
    )
    response = handler_view(request)
    assert response.status_code == 401
