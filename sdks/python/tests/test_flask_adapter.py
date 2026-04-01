"""Tests for the Flask server adapter."""

from __future__ import annotations

import json

from flask import Flask

from autonoma.hmac_util import sign_body
from autonoma.refs import sign_refs
from autonoma.types import HandlerConfig
from autonoma_flask import create_flask_handler


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


def _make_app():
    app = Flask(__name__)
    config = HandlerConfig(
        adapter=FakeAdapter(),
        shared_secret=SHARED_SECRET,
        signing_secret=SIGNING_SECRET,
    )
    bp = create_flask_handler(config)
    app.register_blueprint(bp, url_prefix="/api/autonoma")
    return app


def _post(client, body: dict, secret: str = SHARED_SECRET) -> dict:
    raw = json.dumps(body)
    sig = sign_body(raw, secret)
    resp = client.post(
        "/api/autonoma/",
        data=raw,
        headers={"x-signature": sig, "content-type": "application/json"},
    )
    return {"status": resp.status_code, "body": resp.get_json()}


def test_discover_returns_schema():
    app = _make_app()
    with app.test_client() as client:
        result = _post(client, {"action": "discover"})
        assert result["status"] == 200
        assert result["body"]["sdk"]["server"] == "flask"
        assert result["body"]["sdk"]["language"] == "python"
        assert "models" in result["body"]["schema"]


def test_up_returns_refs():
    app = _make_app()
    with app.test_client() as client:
        result = _post(client, {"action": "up", "create": {"User": {"fields": [{"id": "user-1"}]}}})
        assert result["status"] == 200
        assert "refs" in result["body"]
        assert "refsToken" in result["body"]


def test_down_tears_down():
    app = _make_app()
    with app.test_client() as client:
        token = sign_refs(
            {"refs": {"User": [{"id": "user-1"}]}, "testRunId": "test-run-1", "environment": "test"},
            SIGNING_SECRET,
        )
        result = _post(client, {"action": "down", "refsToken": token})
        assert result["status"] == 200
        assert result["body"]["ok"] is True


def test_rejects_invalid_signature():
    app = _make_app()
    with app.test_client() as client:
        raw = json.dumps({"action": "discover"})
        resp = client.post(
            "/api/autonoma/",
            data=raw,
            headers={"x-signature": "bad-sig", "content-type": "application/json"},
        )
        assert resp.status_code == 401


def test_rejects_invalid_json():
    app = _make_app()
    with app.test_client() as client:
        raw = "not json"
        sig = sign_body(raw, SHARED_SECRET)
        resp = client.post(
            "/api/autonoma/",
            data=raw,
            headers={"x-signature": sig, "content-type": "application/json"},
        )
        assert resp.status_code == 400
