"""Tests for the FastAPI server adapter."""

from __future__ import annotations

import json

from fastapi import FastAPI, Request
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
        auth=lambda user, ctx: {"headers": {"Authorization": "Bearer test-token"}},
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


# --- config_factory tests ---

def _make_client_with_factory() -> TestClient:
    from autonoma_fastapi import create_fastapi_handler
    app = FastAPI()
    router = create_fastapi_handler(config_factory=_make_config)
    app.include_router(router, prefix="/api/autonoma")
    return TestClient(app)


def test_config_factory_discover():
    client = _make_client_with_factory()
    result = _post(client, {"action": "discover"})
    assert result["status"] == 200
    assert result["body"]["sdk"]["server"] == "fastapi"


def test_config_factory_creates_fresh_config_per_request():
    """Each request should call the factory, producing a distinct config."""
    call_count = 0

    def counting_factory() -> HandlerConfig:
        nonlocal call_count
        call_count += 1
        return _make_config()

    from autonoma_fastapi import create_fastapi_handler
    app = FastAPI()
    router = create_fastapi_handler(config_factory=counting_factory)
    app.include_router(router, prefix="/api/autonoma")
    client = TestClient(app)

    _post(client, {"action": "discover"})
    _post(client, {"action": "discover"})
    assert call_count == 2


def test_config_and_factory_raises():
    from autonoma_fastapi import create_fastapi_handler
    import pytest
    with pytest.raises(TypeError, match="not both"):
        create_fastapi_handler(config=_make_config(), config_factory=_make_config)


def test_neither_config_nor_factory_raises():
    from autonoma_fastapi import create_fastapi_handler
    import pytest
    with pytest.raises(TypeError, match="required"):
        create_fastapi_handler()



# --- fastapi_handler standalone tests ---

def _make_standalone_client(*, config=None, config_factory=None) -> TestClient:
    from autonoma_fastapi import fastapi_handler
    app = FastAPI()

    @app.post("/api/autonoma/")
    async def handler(request: Request):
        return await fastapi_handler(config=config, request=request, config_factory=config_factory)

    return TestClient(app)


def test_standalone_handler_with_config():
    client = _make_standalone_client(config=_make_config())
    result = _post(client, {"action": "discover"})
    assert result["status"] == 200
    assert result["body"]["sdk"]["server"] == "fastapi"


def test_standalone_handler_with_factory():
    client = _make_standalone_client(config_factory=_make_config)
    result = _post(client, {"action": "discover"})
    assert result["status"] == 200
    assert result["body"]["sdk"]["server"] == "fastapi"


def test_standalone_handler_factory_called_per_request():
    call_count = 0

    def counting_factory() -> HandlerConfig:
        nonlocal call_count
        call_count += 1
        return _make_config()

    client = _make_standalone_client(config_factory=counting_factory)
    _post(client, {"action": "discover"})
    _post(client, {"action": "discover"})
    assert call_count == 2


async def test_standalone_handler_config_and_factory_raises():
    from autonoma_fastapi import fastapi_handler
    import pytest
    with pytest.raises(TypeError, match="not both"):
        await fastapi_handler(config=_make_config(), request=None, config_factory=_make_config)


async def test_standalone_handler_neither_raises():
    from autonoma_fastapi import fastapi_handler
    import pytest
    with pytest.raises(TypeError, match="required"):
        await fastapi_handler(request=None)
