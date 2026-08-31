"""Tests for the deterministic uniqueness helpers."""

import re

from autonoma.unique import unique_email, unique_id, unique_slug, unique_token


def test_deterministic_per_run_and_inputs():
    assert unique_token("run-1", "a") == unique_token("run-1", "a")
    assert unique_email("run-1") == unique_email("run-1")
    assert unique_slug("run-1", "Acme Inc") == unique_slug("run-1", "Acme Inc")
    assert unique_id("run-1", "user") == unique_id("run-1", "user")


def test_differ_across_run_ids():
    assert unique_token("run-1", "a") != unique_token("run-2", "a")
    assert unique_email("run-1") != unique_email("run-2")


def test_differ_across_inputs_within_a_run():
    assert unique_token("run-1", "a") != unique_token("run-1", "b")


def test_well_shaped_values():
    assert re.fullmatch(r"qa\+[a-f0-9]{12}@test\.dev", unique_email("r", "qa", "test.dev"))
    assert re.fullmatch(r"acme-inc-[a-f0-9]{12}", unique_slug("r", "Acme Inc!"))
    assert re.fullmatch(r"org_[a-f0-9]{12}", unique_id("r", "org"))
