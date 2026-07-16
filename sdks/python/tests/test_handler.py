"""Tests for handler.py — handle_request.

Factory-driven design: every test registers Pydantic-typed factories.
There is no executor or SQL fallback to exercise.
"""

import json

import pytest
from pydantic import BaseModel, ConfigDict

from autonoma.factory import define_factory
from autonoma.handler import handle_request
from autonoma.hmac_util import sign_body
from autonoma.types import HandlerConfig, HandlerRequest


# ---------------------------------------------------------------------------
# Test models
# ---------------------------------------------------------------------------


class OrganizationInput(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str


class UserInput(BaseModel):
    model_config = ConfigDict(extra="ignore")
    email: str
    name: str
    organizationId: str | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_config(
    *,
    factories=None,
    shared="shared-secret",
    signing="signing-secret",
):
    return HandlerConfig(
        scope_field="organizationId",
        shared_secret=shared,
        signing_secret=signing,
        auth=lambda user, ctx: {
            "headers": {
                "Authorization": f"Bearer test-token-{user['id'] if user else 'anon'}"
            }
        },
        factories=factories or {},
    )


def _signed_request(body_dict, secret="shared-secret"):
    body_str = json.dumps(body_dict)
    return HandlerRequest(body=body_str, headers={"x-signature": sign_body(body_str, secret)})


def _org_factory(records=None):
    records = records if records is not None else []

    async def create(data: OrganizationInput, ctx):
        record = {"id": f"org-{len(records) + 1}", "name": data.name}
        records.append(record)
        return record

    return define_factory(create=create, input_model=OrganizationInput)


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

    async def test_serves_even_when_allow_production_is_false(self):
        # allow_production is a deprecated no-op: even an explicit False must
        # not block the endpoint. HMAC signing is the gate.
        config = _make_config()
        config.allow_production = False
        req = _signed_request({"action": "discover"})
        result = await handle_request(config, req)
        assert result.status == 200
        assert result.body["sdk"]["language"] == "python"

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
    async def test_empty_factories_returns_empty_models(self):
        config = _make_config()
        result = await handle_request(config, _signed_request({"action": "discover"}))
        assert result.status == 200
        assert result.body["schema"]["models"] == []
        assert result.body["schema"]["edges"] == []
        assert result.body["schema"]["relations"] == []
        assert result.body["schema"]["scopeField"] == "organizationId"

    async def test_returns_factory_models(self):
        config = _make_config(
            factories={
                "Organization": _org_factory(),
                "User": define_factory(
                    create=lambda data, ctx: {"id": "u-1", "email": data.email, "name": data.name},
                    input_model=UserInput,
                ),
            },
        )
        result = await handle_request(config, _signed_request({"action": "discover"}))
        assert result.status == 200
        names = [m["name"] for m in result.body["schema"]["models"]]
        assert names == ["Organization", "User"]
        org_fields = {f["name"] for f in result.body["schema"]["models"][0]["fields"]}
        assert {"id", "name"}.issubset(org_fields)

    async def test_includes_version_and_sdk_metadata(self):
        config = _make_config(factories={"Organization": _org_factory()})
        result = await handle_request(config, _signed_request({"action": "discover"}))
        assert result.body["sdk"]["language"] == "python"
        assert "version" in result.body


# ---------------------------------------------------------------------------
# up
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestUp:
    async def test_factory_create_called_with_validated_input(self):
        captured = []

        async def create(data, ctx):
            captured.append((type(data).__name__, data.name))
            return {"id": "org-1", "name": data.name}

        config = _make_config(
            factories={"Organization": define_factory(create=create, input_model=OrganizationInput)},
        )
        result = await handle_request(
            config,
            _signed_request(
                {
                    "action": "up",
                    "create": {"Organization": [{"name": "Acme"}]},
                    "testRunId": "run-1",
                },
            ),
        )
        assert result.status == 200, result.body
        assert captured == [("OrganizationInput", "Acme")]
        assert result.body["refs"]["Organization"][0]["id"] == "org-1"

    async def test_alias_ref_resolves_to_real_id(self):
        async def org_create(data, ctx):
            return {"id": "org-resolved", "name": data.name}

        received = {}

        async def user_create(data, ctx):
            received["organizationId"] = data.organizationId
            return {
                "id": "user-1",
                "email": data.email,
                "organizationId": data.organizationId,
            }

        config = _make_config(
            factories={
                "Organization": define_factory(create=org_create, input_model=OrganizationInput),
                "User": define_factory(create=user_create, input_model=UserInput),
            },
        )
        result = await handle_request(
            config,
            _signed_request(
                {
                    "action": "up",
                    "create": {
                        "Organization": [{"_alias": "org", "name": "Acme"}],
                        "User": [
                            {
                                "email": "a@b.com",
                                "name": "A",
                                "organizationId": {"_ref": "org"},
                            }
                        ],
                    },
                    "testRunId": "run-2",
                },
            ),
        )
        assert result.status == 200, result.body
        assert received["organizationId"] == "org-resolved"

    async def test_missing_pk_returns_factory_missing_pk_error(self):
        async def create(data, ctx):
            return {"name": data.name}  # no id

        config = _make_config(
            factories={"Organization": define_factory(create=create, input_model=OrganizationInput)},
        )
        result = await handle_request(
            config,
            _signed_request(
                {
                    "action": "up",
                    "create": {"Organization": [{"name": "NoPK"}]},
                    "testRunId": "run-3",
                },
            ),
        )
        assert result.status == 500
        assert result.body["code"] == "FACTORY_MISSING_PK"

    async def test_unknown_model_in_create_is_invalid_body(self):
        config = _make_config(factories={"Organization": _org_factory()})
        result = await handle_request(
            config,
            _signed_request(
                {
                    "action": "up",
                    "create": {"Mystery": [{"foo": "bar"}]},
                    "testRunId": "run-4",
                },
            ),
        )
        assert result.status == 400
        assert result.body["code"] == "INVALID_BODY"

    async def test_dangling_ref_is_invalid_body(self):
        config = _make_config(factories={"Organization": _org_factory()})
        result = await handle_request(
            config,
            _signed_request(
                {
                    "action": "up",
                    "create": {
                        "Organization": [
                            {"name": "Acme", "tenantId": {"_ref": "does-not-exist"}}
                        ]
                    },
                    "testRunId": "run-5",
                },
            ),
        )
        assert result.status == 400
        assert result.body["code"] == "INVALID_BODY"

    async def test_token_substitution_in_payload(self):
        captured = {}

        async def create(data, ctx):
            captured["name"] = data.name
            return {"id": "org-1", "name": data.name}

        config = _make_config(
            factories={"Organization": define_factory(create=create, input_model=OrganizationInput)},
        )
        result = await handle_request(
            config,
            _signed_request(
                {
                    "action": "up",
                    "create": {"Organization": [{"name": "Acme {{testRunId}}"}]},
                    "testRunId": "run-token",
                },
            ),
        )
        assert result.status == 200
        assert captured["name"] == "Acme run-token"


# ---------------------------------------------------------------------------
# down
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestDown:
    async def test_teardown_called_in_reverse_order(self):
        teardown_calls = []

        async def org_create(data, ctx):
            return {"id": f"org-{data.name}", "name": data.name}

        async def org_teardown(record, ctx):
            teardown_calls.append(record["id"])

        config = _make_config(
            factories={
                "Organization": define_factory(
                    create=org_create,
                    teardown=org_teardown,
                    input_model=OrganizationInput,
                ),
            },
        )
        up_res = await handle_request(
            config,
            _signed_request(
                {
                    "action": "up",
                    "create": {"Organization": [{"name": "A"}, {"name": "B"}]},
                    "testRunId": "run-td",
                },
            ),
        )
        assert up_res.status == 200
        refs_token = up_res.body["refsToken"]

        down_res = await handle_request(
            config,
            _signed_request({"action": "down", "refsToken": refs_token}),
        )
        assert down_res.status == 200
        assert teardown_calls == ["org-B", "org-A"]

    async def test_teardown_skips_models_without_teardown(self):
        # Org has teardown; User does not. Both are torn down only if teardown is present.
        org_td_calls = []

        async def org_create(data, ctx):
            return {"id": "org-1", "name": data.name}

        async def org_teardown(record, ctx):
            org_td_calls.append(record["id"])

        async def user_create(data, ctx):
            return {"id": "u-1", "email": data.email, "name": data.name}

        config = _make_config(
            factories={
                "Organization": define_factory(
                    create=org_create, teardown=org_teardown, input_model=OrganizationInput,
                ),
                "User": define_factory(create=user_create, input_model=UserInput),
            },
        )
        up_res = await handle_request(
            config,
            _signed_request(
                {
                    "action": "up",
                    "create": {
                        "Organization": [{"name": "Acme"}],
                        "User": [{"email": "a@b.com", "name": "A"}],
                    },
                    "testRunId": "run-mixed",
                },
            ),
        )
        assert up_res.status == 200

        down_res = await handle_request(
            config,
            _signed_request({"action": "down", "refsToken": up_res.body["refsToken"]}),
        )
        assert down_res.status == 200
        assert org_td_calls == ["org-1"]
