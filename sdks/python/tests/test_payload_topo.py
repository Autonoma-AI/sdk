"""Tests for the payload-derived topo sort.

The SDK no longer consults a static FK schema. ``_alias`` and ``_ref``
inside the create payload describe the dependency graph; ``payload_topo``
turns that into an ordered list of operations.
"""

import pytest

from autonoma.errors import AutonomaError
from autonoma.payload_topo import compute_teardown_order, resolve_payload_tree


def _models(tree):
    return [op.model for op in tree.ops]


class TestResolvePayloadTree:
    def test_orders_dependents_after_aliased_targets(self):
        tree = resolve_payload_tree(
            {
                "Org": [{"_alias": "o", "name": "Acme"}],
                "User": [
                    {"email": "a@b.com", "orgId": {"_ref": "o"}},
                    {"email": "c@d.com", "orgId": {"_ref": "o"}},
                ],
            }
        )
        assert _models(tree) == ["Org", "User", "User"]

    def test_payload_order_used_as_stable_tie_breaker(self):
        # User comes before Org in the payload but depends on Org via _ref —
        # Org must still be created first, but the second User and Org's
        # other rows preserve declaration order.
        tree = resolve_payload_tree(
            {
                "User": [{"email": "first@x.com", "orgId": {"_ref": "o"}}],
                "Org": [{"_alias": "o", "name": "Acme"}],
            }
        )
        assert _models(tree) == ["Org", "User"]

    def test_refs_inside_nested_dicts_count_as_dependencies(self):
        tree = resolve_payload_tree(
            {
                "Org": [{"_alias": "o", "name": "Acme"}],
                "Settings": [
                    {
                        "key": "primary_org",
                        "value": {"data": {"orgId": {"_ref": "o"}}},
                    }
                ],
            }
        )
        assert _models(tree) == ["Org", "Settings"]

    def test_dangling_ref_raises_invalid_body(self):
        with pytest.raises(AutonomaError) as exc:
            resolve_payload_tree(
                {"User": [{"email": "x@y.com", "orgId": {"_ref": "missing"}}]}
            )
        assert exc.value.code == "INVALID_BODY"

    def test_duplicate_alias_raises(self):
        with pytest.raises(AutonomaError) as exc:
            resolve_payload_tree(
                {
                    "Org": [
                        {"_alias": "o", "name": "A"},
                        {"_alias": "o", "name": "B"},
                    ]
                }
            )
        assert exc.value.code == "INVALID_BODY"

    def test_cycle_raises_invalid_body(self):
        with pytest.raises(AutonomaError) as exc:
            resolve_payload_tree(
                {
                    "A": [{"_alias": "a", "ref": {"_ref": "b"}}],
                    "B": [{"_alias": "b", "ref": {"_ref": "a"}}],
                }
            )
        assert exc.value.code == "INVALID_BODY"
        assert "cycle" in exc.value.message.lower()

    def test_aliases_map_records_temp_ids(self):
        tree = resolve_payload_tree(
            {"Org": [{"_alias": "o", "name": "Acme"}]}
        )
        assert "o" in tree.aliases
        assert tree.alias_owner_model["o"] == "Org"

    def test_self_reference_is_not_a_cycle(self):
        # An entity referencing its own alias is a no-op for ordering.
        tree = resolve_payload_tree(
            {"Org": [{"_alias": "o", "parent": {"_ref": "o"}, "name": "Acme"}]}
        )
        assert _models(tree) == ["Org"]


class TestComputeTeardownOrder:
    def test_uses_alias_dependencies_when_provided(self):
        # Org → User: User depends on Org, so teardown must remove User first.
        order = compute_teardown_order(
            refs={"Org": [{"id": "o-1"}], "User": [{"id": "u-1"}]},
            alias_dependencies={"o": [], "u": ["o"]},
            alias_owner_model={"o": "Org", "u": "User"},
        )
        assert order == ["User", "Org"]

    def test_falls_back_to_reverse_refs_order_without_aliases(self):
        order = compute_teardown_order(
            refs={"Org": [], "User": [], "Note": []},
            alias_dependencies=None,
            alias_owner_model=None,
        )
        assert order == ["Note", "User", "Org"]
