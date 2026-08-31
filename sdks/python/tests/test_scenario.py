"""Tests for define_scenario and check_scenario."""

import pytest

from autonoma.check import check_scenario
from autonoma.scenario import define_scenario


def test_define_scenario_returns_definition():
    s = define_scenario(name="a", description="b", up=lambda ctx: {})
    assert s.name == "a"
    assert s.down is None


def test_define_scenario_rejects_empty_name():
    with pytest.raises(ValueError, match="name"):
        define_scenario(name="", description="b", up=lambda ctx: {})


def test_define_scenario_rejects_non_callable_up():
    with pytest.raises(ValueError, match="up"):
        define_scenario(name="a", description="b", up="nope")


@pytest.mark.asyncio
async def test_check_scenario_round_trip_ok():
    torn = {"down": False}

    def down(ctx):
        torn["down"] = True

    scenario = define_scenario(
        name="roundtrip",
        description="x",
        up=lambda ctx: {"teardown": {"id": ctx.test_run_id}},
        down=down,
    )
    result = await check_scenario(scenario, {"testRunId": "run-1"})
    assert result.valid is True
    assert result.phase == "ok"
    assert torn["down"] is True


@pytest.mark.asyncio
async def test_check_scenario_reports_up_failure():
    def boom(ctx):
        raise RuntimeError("kaboom")

    scenario = define_scenario(name="boom", description="x", up=boom)
    result = await check_scenario(scenario)
    assert result.valid is False
    assert result.phase == "up"
    assert "kaboom" in result.errors[0].message
