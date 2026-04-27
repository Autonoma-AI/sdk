"""Tests for typed-factory support (input_model / ref_model)."""

import json
import pytest
from pydantic import BaseModel, ConfigDict

from autonoma.factory import define_factory
from autonoma.handler import handle_request
from autonoma.hmac_util import sign_body
from autonoma.refs import sign_refs
from autonoma.types import HandlerConfig, HandlerRequest


class FakeExecutor:
    """Executor whose introspection returns no schema. Factories carry the
    schema themselves via input_model/ref_model, so this is fine for tests."""

    async def query(self, sql, params=None):
        return []

    async def transaction(self, fn):
        return await fn(self)


def _config(factories=None):
    return HandlerConfig(
        executor=FakeExecutor(),
        scope_field="organizationId",
        shared_secret="shared",
        signing_secret="signing",
        auth=lambda user, ctx: {},
        factories=factories,
    )


def _signed_request(body_dict, secret="shared"):
    body_str = json.dumps(body_dict)
    sig = sign_body(body_str, secret)
    return HandlerRequest(body=body_str, headers={"x-signature": sig})


# ---------------------------------------------------------------------------
# Models used by the tests
# ---------------------------------------------------------------------------


class ProjectInput(BaseModel):
    """Typed factory input — extra keys ignored (matches our backend pattern)."""

    model_config = ConfigDict(extra="ignore")

    name: str
    priority: int = 0


class ProjectRef(BaseModel):
    id: str
    name: str


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestTypedFactories:
    async def test_input_model_validates_and_passes_typed_instance_to_create(self):
        captured: dict = {}

        def create(data, ctx):
            captured["type"] = type(data).__name__
            captured["name"] = data.name
            captured["priority"] = data.priority
            return {"id": "proj-1", "name": data.name}

        config = _config(
            factories={
                "Project": define_factory(create=create, input_model=ProjectInput),
            },
        )
        req = _signed_request(
            {
                "action": "up",
                "create": {"Project": [{"name": "Apollo", "priority": 5, "ignored": "x"}]},
                "testRunId": "run-1",
            },
        )
        result = await handle_request(config, req)

        assert result.status == 200, result.body
        assert captured == {"type": "ProjectInput", "name": "Apollo", "priority": 5}
        assert result.body["refs"]["Project"][0]["id"] == "proj-1"

    async def test_create_can_return_pydantic_instance_normalized_to_dict(self):
        def create(data, ctx):
            return ProjectRef(id="proj-7", name=data.name)

        config = _config(
            factories={
                "Project": define_factory(create=create, input_model=ProjectInput),
            },
        )
        req = _signed_request(
            {
                "action": "up",
                "create": {"Project": [{"name": "Gemini"}]},
                "testRunId": "run-2",
            },
        )
        result = await handle_request(config, req)

        assert result.status == 200, result.body
        record = result.body["refs"]["Project"][0]
        assert record == {"id": "proj-7", "name": "Gemini"}

    async def test_dict_path_still_works_when_no_input_model(self):
        captured: dict = {}

        def create(data, ctx):
            captured["type"] = type(data).__name__
            captured["data"] = dict(data)
            return {"id": "proj-2", "name": data["name"]}

        config = _config(
            factories={"Project": define_factory(create=create)},
        )
        req = _signed_request(
            {
                "action": "up",
                "create": {"Project": [{"name": "Mercury"}]},
                "testRunId": "run-3",
            },
        )
        result = await handle_request(config, req)

        assert result.status == 200, result.body
        assert captured["type"] == "dict"
        assert captured["data"]["name"] == "Mercury"

    async def test_invalid_input_returns_500_with_validation_error(self):
        # priority must be int — passing "high" should fail validation
        def create(data, ctx):  # pragma: no cover — should not be invoked
            return {"id": "x"}

        config = _config(
            factories={
                "Project": define_factory(create=create, input_model=ProjectInput),
            },
        )
        req = _signed_request(
            {
                "action": "up",
                "create": {"Project": [{"name": "Vulcan", "priority": "high"}]},
                "testRunId": "run-4",
            },
        )
        result = await handle_request(config, req)

        # Validation error bubbles as INTERNAL_ERROR (500) — the user code path
        # is opt-in so we don't introduce a new error code here.
        assert result.status == 500
        assert "priority" in result.body["error"].lower()

    async def test_ref_model_validates_record_for_teardown(self):
        captured: dict = {}

        def create(data, ctx):
            return {"id": "proj-9", "name": data.name}

        def teardown(record, ctx):
            captured["type"] = type(record).__name__
            captured["id"] = record.id
            captured["name"] = record.name

        # Build a refs token directly — exercises the typed teardown path
        refs_token = sign_refs(
            {
                "refs": {"Project": [{"id": "proj-9", "name": "Saturn"}]},
                "testRunId": "run-5",
                "environment": "",
            },
            "signing",
        )
        config = _config(
            factories={
                "Project": define_factory(
                    create=create,
                    teardown=teardown,
                    input_model=ProjectInput,
                    ref_model=ProjectRef,
                ),
            },
        )
        req = _signed_request({"action": "down", "refsToken": refs_token})
        result = await handle_request(config, req)

        assert result.status == 200, result.body
        assert captured == {"type": "ProjectRef", "id": "proj-9", "name": "Saturn"}

    async def test_define_factory_rejects_non_pydantic_models(self):
        with pytest.raises(ValueError, match="model_validate"):
            define_factory(create=lambda d, c: {"id": "x"}, input_model=object)
        with pytest.raises(ValueError, match="model_validate"):
            define_factory(create=lambda d, c: {"id": "x"}, ref_model=object)
