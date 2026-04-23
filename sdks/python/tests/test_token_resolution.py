"""Defense-in-depth token resolution in the SDK up path.

Recipe variables ({{testRunId}}, {{index}}, {{cycle(...)}}) should be
substituted in field values before INSERT. If an unknown {{token}} reaches
the SDK, we raise UNRESOLVED_TOKEN rather than silently inserting the literal.
"""

import pytest

from autonoma.errors import AutonomaError
from autonoma.handler import _resolve_tokens


def test_testrunid_substituted():
    out = _resolve_tokens(
        {"email": "alice-{{testRunId}}@test.local"}, "run-123", 0
    )
    assert out == {"email": "alice-run-123@test.local"}


def test_index_substituted():
    out = _resolve_tokens({"slot": "pos-{{index}}"}, "r", 4)
    assert out == {"slot": "pos-4"}


def test_cycle_substituted():
    # index=0 → first, index=1 → second, index=2 → wraps back to first
    assert _resolve_tokens("{{cycle(a,b)}}", "r", 0) == "a"
    assert _resolve_tokens("{{cycle(a,b)}}", "r", 1) == "b"
    assert _resolve_tokens("{{cycle(a,b)}}", "r", 2) == "a"


def test_cycle_quoted_values():
    assert _resolve_tokens("{{cycle('WEB','IOS','ANDROID')}}", "r", 1) == "IOS"


def test_nested_structures():
    out = _resolve_tokens(
        {
            "users": [
                {"email": "u-{{testRunId}}@t.local"},
                {"email": "v-{{testRunId}}@t.local"},
            ],
            "tags": ["{{testRunId}}-a", "{{testRunId}}-b"],
        },
        "xyz",
        0,
    )
    assert out == {
        "users": [
            {"email": "u-xyz@t.local"},
            {"email": "v-xyz@t.local"},
        ],
        "tags": ["xyz-a", "xyz-b"],
    }


def test_multiple_tokens_in_one_string():
    assert _resolve_tokens("{{testRunId}}-{{index}}", "run", 7) == "run-7"


def test_unknown_token_raises():
    with pytest.raises(AutonomaError) as exc:
        _resolve_tokens({"x": "hello-{{mystery}}"}, "r", 0)
    assert exc.value.code == "UNRESOLVED_TOKEN"
    assert "mystery" in str(exc.value)


def test_non_string_values_passthrough():
    # Numbers, bools, None should be returned untouched
    assert _resolve_tokens(42, "r", 0) == 42
    assert _resolve_tokens(True, "r", 0) is True
    assert _resolve_tokens(None, "r", 0) is None


def test_string_without_tokens_unchanged():
    assert _resolve_tokens("plain string", "r", 0) == "plain string"
