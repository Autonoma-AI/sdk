"""Tests for the FastAPI server adapter."""

from __future__ import annotations

import json
from typing import Optional

from fastapi import FastAPI
from fastapi.testclient import TestClient

from autonoma.hmac_util import sign_body
from autonoma.refs import sign_refs
from autonoma.types import HandlerConfig, HandlerRequest
from autonoma_fastapi import create_fastapi_handler


class FakeAdapter:
    name = "fake"

    def get_schema(self):
        return {
            "models": [{"name": "User", "fields": [{"name": "id", "type": "String", "isRequired": True, "isId": True, "hasDefault": True}]}],
            "edges": [],
            "relations": [],
            "scopeField": "organizationId",
        }

    async def create_entities(self, spec, context):
        return {"User": [{"id": "user-1"}]}

    async def teardown(self, scope_value, refs=None):
        pass


SHARED_SECRET = "test-shared-secret-1234"
SIGNING_SECRET = "test-signing-secret-5678"


def _make_config() -> HandlerConfig:
    return HandlerConfig(
        adapter=FakeAdapter(),
        shared_secret=SHARED_SECRET,
        signing_secret=SIGNING_SECRET,
    )


def _make_client() -> TestClient:
    app = FastAPI()
    router = create_fastapi_handler(_make_config())
    app.include_router(router, prefix="/api/autonoma")
    return TestClient(app)


def _post(client: TestClient, body: dict, secret: str = SHARED_SECRET) -> dict:
    raw = json.dumps(body)
    sig = sign_body(raw, secret)
    resp = client.post("/api/autonoma/", content=raw, headers={"x-signature": sig, "content-type": "application/json"})
    return {"status": resp.status_code, "body": resp.json()}


def test_discover_returns_schema():
    client = _make_client()
    result = _post(client, {"action": "discover"})
    assert result["status"] == 200
    assert result["body"]["sdk"]["server"] == "fastapi"
    assert result["body"]["sdk"]["language"] == "python"
    assert "models" in result["body"]["schema"]


def test_up_returns_refs():
    client = _make_client()
    result = _post(client, {"action": "up", "create": {"User": {"fields": [{"id": "user-1"}]}}})
    assert result["status"] == 200
    assert "refs" in result["body"]
    assert "refsToken" in result["body"]
    assert "auth" in result["body"]


def test_down_tears_down():
    client = _make_client()
    # First create data
    token = sign_refs(
        {"refs": {"User": [{"id": "user-1"}]}, "testRunId": "test-run-1", "environment": "test"},
        SIGNING_SECRET,
    )
    result = _post(client, {"action": "down", "refsToken": token})
    assert result["status"] == 200
    assert result["body"]["ok"] is True


def test_rejects_invalid_signature():
    client = _make_client()
    raw = json.dumps({"action": "discover"})
    resp = client.post("/api/autonoma/", content=raw, headers={"x-signature": "bad-sig", "content-type": "application/json"})
    assert resp.status_code == 401


def test_rejects_invalid_json():
    client = _make_client()
    raw = "not json"
    sig = sign_body(raw, SHARED_SECRET)
    resp = client.post("/api/autonoma/", content=raw, headers={"x-signature": sig, "content-type": "application/json"})
    assert resp.status_code == 400
