"""Tests for template.py — resolve_template."""

from autonoma.template import resolve_template


class TestResolveTemplate:
    def test_resolves_test_run_id(self):
        ctx = {"testRunId": "run-42"}
        result = resolve_template("{{testRunId}}", ctx)
        assert result == "run-42"

    def test_resolves_index_preserves_number_type(self):
        ctx = {"index": 3}
        result = resolve_template("{{index}}", ctx)
        assert result == 3
        assert isinstance(result, int)

    def test_resolves_index1_one_based(self):
        ctx = {"index": 0}
        result = resolve_template("{{index1}}", ctx)
        assert result == 1

    def test_interpolates_in_strings(self):
        ctx = {"testRunId": "abc"}
        result = resolve_template("prefix-{{testRunId}}-suffix", ctx)
        assert result == "prefix-abc-suffix"

    def test_resolves_cycle(self):
        ctx = {"index": 1}
        result = resolve_template("{{cycle(['a', 'b', 'c'])}}", ctx)
        assert result == "b"

    def test_passes_through_non_template_values(self):
        ctx = {}
        assert resolve_template(42, ctx) == 42
        assert resolve_template(True, ctx) is True
        assert resolve_template(None, ctx) is None

    def test_resolves_nested_objects(self):
        ctx = {"testRunId": "run-1", "index": 0}
        value = {"name": "{{testRunId}}", "items": ["{{index}}"]}
        result = resolve_template(value, ctx)
        assert result == {"name": "run-1", "items": [0]}

    def test_resolves_nested_arrays(self):
        ctx = {"testRunId": "x"}
        value = [{"id": "{{testRunId}}"}]
        result = resolve_template(value, ctx)
        assert result == [{"id": "x"}]
