"""Tests for handler.py — handle_request."""

import json
import os

import pytest

from autonoma.handler import handle_request
from autonoma.hmac_util import sign_body
from autonoma.refs import sign_refs
from autonoma.factory import define_factory
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
        auth=lambda user, ctx: {"headers": {"Authorization": f"Bearer test-token-{user['id'] if user else 'anon'}"}},
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

    async def test_blocks_production_when_not_allowed(self, monkeypatch):
        monkeypatch.setenv("PYTHON_ENV", "production")
        monkeypatch.delenv("AUTONOMA_ENABLED", raising=False)
        config = _make_config()
        req = _make_request({"action": "discover"})
        result = await handle_request(config, req)
        assert result.status == 404
        assert result.body["code"] == "PRODUCTION_BLOCKED"

    async def test_autonoma_enabled_overrides_production_block(self, monkeypatch):
        monkeypatch.setenv("PYTHON_ENV", "production")
        monkeypatch.setenv("AUTONOMA_ENABLED", "1")
        config = _make_config()
        req = _make_request({"action": "discover"})
        result = await handle_request(config, req)
        assert result.status == 200

    async def test_autonoma_enabled_zero_does_not_override(self, monkeypatch):
        monkeypatch.setenv("PYTHON_ENV", "production")
        monkeypatch.setenv("AUTONOMA_ENABLED", "0")
        config = _make_config()
        req = _make_request({"action": "discover"})
        result = await handle_request(config, req)
        assert result.status == 404
        assert result.body["code"] == "PRODUCTION_BLOCKED"


class MockExecutor:
    """SQL executor that returns canned introspection data and captures queries."""

    def __init__(self):
        self.queries = []
        self._insert_counter = 0

    async def query(self, sql, params=None):
        self.queries.append(sql)
        trimmed = sql.strip().lower()

        if "information_schema.tables" in trimmed and "table_constraints" not in trimmed:
            return [{"table_name": "organization"}, {"table_name": "user"}]
        if "information_schema.columns" in trimmed and "table_constraints" not in trimmed:
            return [
                {"table_name": "organization", "column_name": "id", "data_type": "uuid", "udt_name": "uuid", "is_nullable": "NO", "column_default": "gen_random_uuid()"},
                {"table_name": "organization", "column_name": "name", "data_type": "text", "udt_name": "text", "is_nullable": "NO", "column_default": None},
                {"table_name": "user", "column_name": "id", "data_type": "uuid", "udt_name": "uuid", "is_nullable": "NO", "column_default": "gen_random_uuid()"},
                {"table_name": "user", "column_name": "email", "data_type": "text", "udt_name": "text", "is_nullable": "NO", "column_default": None},
                {"table_name": "user", "column_name": "name", "data_type": "text", "udt_name": "text", "is_nullable": "NO", "column_default": None},
                {"table_name": "user", "column_name": "organization_id", "data_type": "uuid", "udt_name": "uuid", "is_nullable": "NO", "column_default": None},
            ]
        if "foreign key" in trimmed:
            return [{"from_table": "user", "from_column": "organization_id", "to_table": "organization", "to_column": "id", "is_nullable": "NO"}]
        if "primary key" in trimmed:
            return [{"table_name": "organization", "column_name": "id"}, {"table_name": "user", "column_name": "id"}]
        if "pg_type" in trimmed:
            return []

        # INSERT: return a fake record
        if trimmed.startswith("insert"):
            self._insert_counter += 1
            record = {"id": f"mock-id-{self._insert_counter}"}
            if params:
                import re
                col_match = re.search(r'\(([^)]+)\)\s*VALUES', sql, re.IGNORECASE)
                if col_match:
                    cols = [c.strip().strip('"') for c in col_match.group(1).split(",")]
                    for i, col in enumerate(cols):
                        if i < len(params):
                            record[col] = params[i]
            return [record]

        return []

    async def transaction(self, fn):
        return await fn(self)


def _make_mock_config(**overrides):
    defaults = dict(
        executor=MockExecutor(),
        scope_field="organizationId",
        shared_secret="test-secret",
        signing_secret="test-signing-secret",
        auth=lambda user, ctx: {"headers": {"Authorization": "Bearer token"}},
    )
    defaults.update(overrides)
    return HandlerConfig(**defaults)


@pytest.mark.asyncio
class TestFactories:
    async def test_factory_create_instead_of_sql(self):
        calls = []

        async def org_create(data, ctx):
            calls.append(data)
            return {"id": "factory-org-1", "name": data["name"]}

        executor = MockExecutor()
        config = _make_mock_config(
            executor=executor,
            factories={"Organization": define_factory(create=org_create)},
        )
        req = _make_request(
            {"action": "up", "create": {"Organization": [{"name": "FactoryOrg"}]}, "testRunId": "run-1"},
            secret="test-secret",
        )
        result = await handle_request(config, req)

        assert result.status == 200
        assert len(calls) == 1
        assert calls[0]["name"] == "FactoryOrg"
        assert result.body["refs"]["Organization"][0]["id"] == "factory-org-1"
        # No INSERT for Organization
        org_inserts = [q for q in executor.queries if "insert" in q.lower() and "organization" in q.lower()]
        assert len(org_inserts) == 0

    async def test_hybrid_factory_and_sql(self):
        async def org_create(data, ctx):
            return {"id": "factory-org-1", "name": data["name"]}

        executor = MockExecutor()
        config = _make_mock_config(
            executor=executor,
            factories={"Organization": define_factory(create=org_create)},
        )
        req = _make_request(
            {"action": "up", "create": {"Organization": [{"name": "Org"}], "User": [{"email": "a@b.com", "name": "A"}]}, "testRunId": "run-2"},
            secret="test-secret",
        )
        result = await handle_request(config, req)

        assert result.status == 200
        # User should be created via SQL
        user_inserts = [q for q in executor.queries if "insert" in q.lower() and '"user"' in q.lower()]
        assert len(user_inserts) > 0

    async def test_factory_receives_resolved_fk_ids(self):
        received = {}

        async def org_create(data, ctx):
            return {"id": "resolved-org-id", "name": data["name"]}

        async def user_create(data, ctx):
            received.update(data)
            return {"id": "user-1", "email": data["email"], "organizationId": data.get("organizationId")}

        config = _make_mock_config(
            factories={
                "Organization": define_factory(create=org_create),
                "User": define_factory(create=user_create),
            },
        )
        # Nest User under Organization so tree resolver wires the FK
        req = _make_request(
            {"action": "up", "create": {"Organization": [{"name": "Org", "User": [{"email": "a@b.com", "name": "A"}]}]}, "testRunId": "run-3"},
            secret="test-secret",
        )
        result = await handle_request(config, req)

        assert result.status == 200
        assert received.get("organizationId") == "resolved-org-id"

    async def test_factory_missing_pk_error(self):
        async def org_create(data, ctx):
            return {"name": data["name"]}  # missing 'id'

        config = _make_mock_config(
            factories={"Organization": define_factory(create=org_create)},
        )
        req = _make_request(
            {"action": "up", "create": {"Organization": [{"name": "NoPK"}]}, "testRunId": "run-4"},
            secret="test-secret",
        )
        result = await handle_request(config, req)

        assert result.status == 500
        assert result.body["code"] == "FACTORY_MISSING_PK"

    async def test_factory_teardown_called_per_record(self):
        teardown_calls = []

        async def org_create(data, ctx):
            return {"id": f"org-{data['name']}", "name": data["name"]}

        async def org_teardown(record, ctx):
            teardown_calls.append(record["id"])

        config = _make_mock_config(
            factories={"Organization": define_factory(create=org_create, teardown=org_teardown)},
        )
        # Create
        up_req = _make_request(
            {"action": "up", "create": {"Organization": [{"name": "A"}, {"name": "B"}]}, "testRunId": "run-5"},
            secret="test-secret",
        )
        up_res = await handle_request(config, up_req)
        assert up_res.status == 200
        refs_token = up_res.body["refsToken"]

        # Teardown
        down_req = _make_request({"action": "down", "refsToken": refs_token}, secret="test-secret")
        down_res = await handle_request(config, down_req)

        assert down_res.status == 200
        assert len(teardown_calls) == 2
        assert teardown_calls == ["org-B", "org-A"]  # reverse order

    async def test_sql_fallback_teardown(self):
        async def org_create(data, ctx):
            return {"id": "org-1", "name": data["name"]}

        executor = MockExecutor()
        config = _make_mock_config(
            executor=executor,
            factories={"Organization": define_factory(create=org_create)},  # no teardown
        )
        up_req = _make_request(
            {"action": "up", "create": {"Organization": [{"name": "Org"}]}, "testRunId": "run-6"},
            secret="test-secret",
        )
        up_res = await handle_request(config, up_req)
        assert up_res.status == 200

        down_req = _make_request({"action": "down", "refsToken": up_res.body["refsToken"]}, secret="test-secret")
        down_res = await handle_request(config, down_req)

        assert down_res.status == 200
        delete_queries = [q for q in executor.queries if "delete" in q.lower()]
        assert len(delete_queries) > 0

    async def test_factory_context_has_refs(self):
        captured_ctx = {}

        async def org_create(data, ctx):
            return {"id": "org-ctx", "name": data["name"]}

        async def user_create(data, ctx):
            captured_ctx["refs"] = dict(ctx.refs)
            captured_ctx["test_run_id"] = ctx.test_run_id
            return {"id": "user-ctx", "email": data["email"], "organizationId": data.get("organizationId")}

        config = _make_mock_config(
            factories={
                "Organization": define_factory(create=org_create),
                "User": define_factory(create=user_create),
            },
        )
        req = _make_request(
            {"action": "up", "create": {"Organization": [{"name": "Org"}], "User": [{"email": "x@y.com", "name": "X"}]}, "testRunId": "run-7"},
            secret="test-secret",
        )
        await handle_request(config, req)

        assert "Organization" in captured_ctx["refs"]
        assert len(captured_ctx["refs"]["Organization"]) == 1
        assert captured_ctx["refs"]["Organization"][0]["id"] == "org-ctx"
        assert captured_ctx["test_run_id"] == "run-7"
