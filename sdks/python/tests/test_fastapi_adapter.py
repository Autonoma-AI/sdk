"""Tests for the FastAPI server adapter."""

from __future__ import annotations

import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

from autonoma.hmac_util import sign_body
from autonoma.refs import sign_refs
from autonoma.types import HandlerConfig, HandlerRequest


class FakeExecutor:
    """Minimal SQL executor for testing."""
    async def query(self, sql, params=None):
        return []
    async def transaction(self, fn):
        return await fn(self)


SHARED_SECRET = "test-shared-secret-1234"
SIGNING_SECRET = "test-signing-secret-5678"


def _make_config() -> HandlerConfig:
    return HandlerConfig(
        executor=FakeExecutor(),
        scope_field="organizationId",
        shared_secret=SHARED_SECRET,
        signing_secret=SIGNING_SECRET,
    )


def _make_client() -> TestClient:
    from autonoma_fastapi import create_fastapi_handler
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
