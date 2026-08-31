"""Tests for handler.py - handle_request (Scenario v2)."""

import json

import pytest

from autonoma.handler import handle_request
from autonoma.hmac_util import sign_body
from autonoma.refs import sign_refs
from autonoma.scenario import define_scenario
from autonoma.types import HandlerConfig, HandlerRequest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_config(*, scenarios=None, shared="shared-secret", signing="signing-secret", **kwargs):
    return HandlerConfig(
        shared_secret=shared,
        signing_secret=signing,
        scenarios=scenarios or [],
        **kwargs,
    )


def _signed_request(body_dict, secret="shared-secret"):
    body_str = json.dumps(body_dict)
    return HandlerRequest(body=body_str, headers={"x-signature": sign_body(body_str, secret)})


def _single_user():
    return define_scenario(
        name="single-user",
        description="One user in a fresh org",
        up=lambda ctx: {
            "auth": {"headers": {"Authorization": f"Bearer jwt-{ctx.test_run_id}"}},
            "teardown": {"user_id": f"user-{ctx.test_run_id}"},
        },
    )


# ---------------------------------------------------------------------------
# Protocol-level tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestHandleRequest:
    async def test_rejects_invalid_hmac_signature(self):
        config = _make_config()
        req = HandlerRequest(body='{"action":"discover"}', headers={"x-signature": "bad"})
        result = await handle_request(config, req)
        assert result.status == 401
        assert result.body["code"] == "INVALID_SIGNATURE"

    async def test_rejects_same_shared_and_signing_secrets(self):
        config = _make_config(shared="same", signing="same")
        req = _signed_request({"action": "discover"}, secret="same")
        result = await handle_request(config, req)
        assert result.status == 500
        assert result.body["code"] == "SAME_SECRETS"

    async def test_returns_400_for_unknown_action(self):
        config = _make_config()
        req = _signed_request({"action": "bogus"})
        result = await handle_request(config, req)
        assert result.status == 400
        assert result.body["code"] == "UNKNOWN_ACTION"

    async def test_returns_400_for_invalid_json(self):
        config = _make_config()
        body_str = "not json at all"
        req = HandlerRequest(body=body_str, headers={"x-signature": sign_body(body_str, "shared-secret")})
        result = await handle_request(config, req)
        assert result.status == 400
        assert result.body["code"] == "INVALID_BODY"


# ---------------------------------------------------------------------------
# discover
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestDiscover:
    async def test_empty_scenarios_returns_empty_list(self):
        config = _make_config()
        result = await handle_request(config, _signed_request({"action": "discover"}))
        assert result.status == 200
        assert result.body["scenarios"] == []
        assert result.body["version"] == "2.0"

    async def test_lists_registered_scenarios(self):
        config = _make_config(
            scenarios=[
                _single_user(),
                define_scenario(name="empty", description="Nothing seeded", up=lambda ctx: {}),
            ],
        )
        result = await handle_request(config, _signed_request({"action": "discover"}))
        assert result.status == 200
        assert result.body["scenarios"] == [
            {"name": "single-user", "description": "One user in a fresh org"},
            {"name": "empty", "description": "Nothing seeded"},
        ]
        assert "schema" not in result.body
        assert result.body["sdk"]["language"] == "python"


# ---------------------------------------------------------------------------
# up
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestUp:
    async def test_runs_scenario_up_and_returns_envelope(self):
        config = _make_config(scenarios=[_single_user()])
        result = await handle_request(
            config,
            _signed_request(
                {"action": "up", "scenario": {"name": "single-user"}, "testRunId": "run-1"}
            ),
        )
        assert result.status == 200, result.body
        assert result.body["version"] == "2.0"
        assert result.body["auth"]["headers"]["Authorization"] == "Bearer jwt-run-1"
        assert isinstance(result.body["teardownToken"], str)
        # The duplicated plaintext refs and the old refsToken field are gone.
        assert "refs" not in result.body
        assert "refsToken" not in result.body
        assert result.body["expiresInSeconds"] == 3600

    async def test_applies_configured_expiry(self):
        config = _make_config(scenarios=[_single_user()], expires_in_seconds=900)
        result = await handle_request(
            config,
            _signed_request({"action": "up", "scenario": {"name": "single-user"}, "testRunId": "r"}),
        )
        assert result.body["expiresInSeconds"] == 900

    async def test_omits_auth_when_absent(self):
        config = _make_config(
            scenarios=[define_scenario(name="bare", description="x", up=lambda ctx: {})]
        )
        result = await handle_request(
            config,
            _signed_request({"action": "up", "scenario": {"name": "bare"}, "testRunId": "r"}),
        )
        assert result.status == 200
        assert "auth" not in result.body
        assert isinstance(result.body["teardownToken"], str)

    async def test_unknown_scenario_name_is_unknown_environment(self):
        config = _make_config(scenarios=[_single_user()])
        result = await handle_request(
            config,
            _signed_request({"action": "up", "scenario": {"name": "nope"}, "testRunId": "r"}),
        )
        assert result.status == 400
        assert result.body["code"] == "UNKNOWN_ENVIRONMENT"

    async def test_missing_scenario_name_is_invalid_body(self):
        config = _make_config(scenarios=[_single_user()])
        result = await handle_request(config, _signed_request({"action": "up", "testRunId": "r"}))
        assert result.status == 400
        assert result.body["code"] == "INVALID_BODY"


# ---------------------------------------------------------------------------
# down
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestDown:
    async def test_routes_to_scenario_down_with_token_teardown(self):
        captured = {}

        def down(ctx):
            captured["name"] = ctx.name
            captured["teardown"] = ctx.teardown
            captured["test_run_id"] = ctx.test_run_id

        scenario = define_scenario(
            name="teardownable",
            description="x",
            up=lambda ctx: {"teardown": {"handle": f"h-{ctx.test_run_id}"}},
            down=down,
        )
        config = _make_config(scenarios=[scenario])

        up_res = await handle_request(
            config,
            _signed_request({"action": "up", "scenario": {"name": "teardownable"}, "testRunId": "run-x"}),
        )
        assert up_res.status == 200
        teardown_token = up_res.body["teardownToken"]

        down_res = await handle_request(
            config,
            _signed_request(
                {"action": "down", "teardownToken": teardown_token, "testRunId": "run-x"}
            ),
        )
        assert down_res.status == 200
        assert down_res.body["ok"] is True
        assert captured == {
            "name": "teardownable",
            "teardown": {"handle": "h-run-x"},
            "test_run_id": "run-x",
        }

    async def test_recovers_name_from_token_when_request_omits_it(self):
        ran = {"down": False}

        def down(ctx):
            ran["down"] = True

        scenario = define_scenario(
            name="from-token", description="x", up=lambda ctx: {"teardown": {}}, down=down
        )
        config = _make_config(scenarios=[scenario])
        teardown_token = sign_refs(
            {"refs": {}, "testRunId": "r", "environment": "from-token"}, config.signing_secret
        )
        res = await handle_request(
            config, _signed_request({"action": "down", "teardownToken": teardown_token})
        )
        assert res.status == 200
        assert ran["down"] is True

    async def test_no_op_when_scenario_has_no_down(self):
        scenario = define_scenario(name="no-down", description="x", up=lambda ctx: {"teardown": {}})
        config = _make_config(scenarios=[scenario])
        teardown_token = sign_refs(
            {"refs": {}, "testRunId": "r", "environment": "no-down"}, config.signing_secret
        )
        res = await handle_request(
            config, _signed_request({"action": "down", "teardownToken": teardown_token})
        )
        assert res.status == 200
        assert res.body["ok"] is True

    async def test_rejects_tampered_teardown_token(self):
        config = _make_config()
        res = await handle_request(
            config, _signed_request({"action": "down", "teardownToken": "bad.token.here"})
        )
        assert res.status == 403
        assert res.body["code"] == "INVALID_TEARDOWN_TOKEN"
