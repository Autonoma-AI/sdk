"""Tests for the Django view handler."""

from __future__ import annotations

import json

import django
from django.conf import settings

# Configure Django before anything else
import os
import tempfile

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
from django.test import RequestFactory

from autonoma.hmac_util import sign_body
from autonoma.types import HandlerConfig


# ---------------------------------------------------------------------------
# View Handler Tests
# ---------------------------------------------------------------------------

SHARED_SECRET = "test-shared-secret-1234"
SIGNING_SECRET = "test-signing-secret-5678"


class FakeExecutor:
    """Minimal SQL executor returning canned introspection results."""

    async def query(self, sql, params=None):
        sql_lower = sql.lower().strip()
        if sql_lower.startswith("select table_name"):
            return [{"table_name": "users"}]
        if sql_lower.startswith("select\n  table_name,\n  column_name"):
            return [
                {"table_name": "users", "column_name": "id", "data_type": "uuid",
                 "udt_name": "uuid", "is_nullable": "NO", "column_default": "gen_random_uuid()"},
                {"table_name": "users", "column_name": "email", "data_type": "character varying",
                 "udt_name": "varchar", "is_nullable": "NO", "column_default": None},
            ]
        return []

    async def transaction(self, fn):
        return await fn(self)


@pytest.fixture
def handler_view():
    from autonoma_django import create_django_handler
    config = HandlerConfig(
        executor=FakeExecutor(),
        scope_field="organizationId",
        shared_secret=SHARED_SECRET,
        signing_secret=SIGNING_SECRET,
        auth=lambda user, ctx: {"headers": {"Authorization": "Bearer test-token"}},
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
