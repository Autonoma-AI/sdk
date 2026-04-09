"""Tests for handler.py — handle_request."""

import json
import pytest

from autonoma.handler import handle_request
from autonoma.hmac_util import sign_body
from autonoma.types import HandlerConfig, HandlerRequest


class FakeExecutor:
    """Minimal SQL executor that returns empty results for introspection queries."""

    async def query(self, sql, params=None):
        # Return empty results for all introspection queries
        return []

    async def transaction(self, fn):
        return await fn(self)


def _make_config(shared="shared-secret", signing="signing-secret"):
    return HandlerConfig(
        executor=FakeExecutor(),
        scope_field="organizationId",
        shared_secret=shared,
        signing_secret=signing,
        auth=lambda user: {"headers": {"Authorization": f"Bearer test-token-{user['id'] if user else 'anon'}"}},
    )


def _make_request(body_dict, secret="shared-secret"):
    body_str = json.dumps(body_dict)
    sig = sign_body(body_str, secret)
    return HandlerRequest(body=body_str, headers={"x-signature": sig})


@pytest.mark.asyncio
class TestHandleRequest:
    async def test_rejects_invalid_hmac_signature(self):
        config = _make_config()
        req = HandlerRequest(
            body='{"action":"discover"}',
            headers={"x-signature": "bad"},
        )
        result = await handle_request(config, req)
        assert result.status == 401
        assert result.body["code"] == "INVALID_SIGNATURE"

    async def test_rejects_same_shared_and_signing_secrets(self):
        config = _make_config(shared="same", signing="same")
        req = _make_request({"action": "discover"}, secret="same")
        result = await handle_request(config, req)
        assert result.status == 500
        assert result.body["code"] == "SAME_SECRETS"

    async def test_returns_schema_on_discover(self):
        config = _make_config()
        req = _make_request({"action": "discover"})
        result = await handle_request(config, req)
        assert result.status == 200
        assert "schema" in result.body
        assert result.body["schema"]["models"] == []

    async def test_discover_response_includes_version_and_sdk(self):
        config = _make_config()
        req = _make_request({"action": "discover"})
        result = await handle_request(config, req)
        assert result.status == 200
        assert "version" in result.body
        assert "sdk" in result.body
        assert result.body["sdk"]["language"] == "python"

    async def test_returns_400_for_unknown_action(self):
        config = _make_config()
        req = _make_request({"action": "bogus"})
        result = await handle_request(config, req)
        assert result.status == 400
        assert result.body["code"] == "UNKNOWN_ACTION"

    async def test_returns_400_for_invalid_json(self):
        config = _make_config()
        body_str = "not json at all"
        sig = sign_body(body_str, "shared-secret")
        req = HandlerRequest(body=body_str, headers={"x-signature": sig})
        result = await handle_request(config, req)
        assert result.status == 400
        assert result.body["code"] == "INVALID_BODY"
