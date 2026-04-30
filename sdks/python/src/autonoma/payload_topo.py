"""Resolve the create payload into an ordered list of operations.

The old SDK derived ordering from a static FK schema (``schema.relations``
+ ``schema.edges``) it had introspected from the database. With factories
owning entity creation, the SDK no longer has — or needs — that schema.
What it does have is the create payload itself, and that already contains
complete dependency information:

* Each entity that other entities depend on declares ``_alias: "name"``.
* Each entity that depends on another carries ``{"_ref": "name"}``
  somewhere in its field tree (top-level FK, nested ``data`` blob, list
  element — anywhere).

Walking the payload to collect ``alias → owner`` and ``owner → {refs}``
gives us the exact dependency graph. Kahn's topo sort over that graph
produces the ``up`` order; the reverse is the ``down`` order.

This module owns:

* :func:`resolve_payload_tree` — build the topo-sorted list of
  ``CreateOp`` items from the create payload, and the alias map used by
  ``up`` to swap ``_ref`` placeholders for real ids.
* :func:`compute_teardown_order` — derive the same dependency graph from
  the alias map captured in the refs token, so teardown can run children
  before parents without consulting any external schema.

Cycles in the alias graph raise :class:`AutonomaError(INVALID_BODY)`. The
old SDK used to break cycles by nullifying nullable FKs; with factories
the host owns FK semantics and the SDK does not modify rows, so we
surface cycles to the caller instead.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from autonoma.errors import invalid_body
from autonoma.types import CreateOp


# ---------------------------------------------------------------------------
# Walking the payload
# ---------------------------------------------------------------------------


_RESERVED_KEYS = {"_alias", "_ref"}


def _collect_refs(value: Any, out: list[str]) -> None:
    """Walk a field value tree and append every ``_ref`` alias found.

    Refs can sit anywhere — top-level FK, nested in a ``data`` JSON blob,
    inside a list of records — so the walker recurses unconditionally.
    """
    if isinstance(value, dict):
        ref = value.get("_ref")
        if isinstance(ref, str):
            out.append(ref)
            return
        for v in value.values():
            _collect_refs(v, out)
    elif isinstance(value, list):
        for v in value:
            _collect_refs(v, out)


def _resolve_refs(value: Any, alias_to_temp_id: dict[str, str]) -> Any:
    """Replace each ``{"_ref": alias}`` with its temp id.

    Aliases that aren't yet known are passed through unchanged — the
    handler swaps them for real ids during ``up`` after each factory
    returns.
    """
    if isinstance(value, dict):
        ref = value.get("_ref")
        if isinstance(ref, str):
            real = alias_to_temp_id.get(ref)
            return real if real is not None else value
        return {k: _resolve_refs(v, alias_to_temp_id) for k, v in value.items()}
    if isinstance(value, list):
        return [_resolve_refs(v, alias_to_temp_id) for v in value]
    return value


# ---------------------------------------------------------------------------
# Tree resolution
# ---------------------------------------------------------------------------


class ResolvedTree:
    """Output of :func:`resolve_payload_tree`."""

    __slots__ = ("ops", "aliases", "alias_owner_model", "alias_dependencies")

    def __init__(self) -> None:
        self.ops: list[CreateOp] = []
        # alias → temp id assigned to the entity declaring that alias
        self.aliases: dict[str, str] = {}
        # alias → model name, used by teardown to pick the right factory
        self.alias_owner_model: dict[str, str] = {}
        # alias → list of aliases the owner depends on (may include unknown
        # aliases; teardown surfaces those as "ignored").
        self.alias_dependencies: dict[str, list[str]] = {}


def resolve_payload_tree(create: dict[str, Any]) -> ResolvedTree:
    """Topo-sort a create payload into an ordered list of ``CreateOp``.

    ``create`` is the dashboard's nested map ``{model: [entity, ...]}``.
    Each entity is a dict; ``_alias`` (declared by dependency targets)
    and ``_ref`` (declared by dependents, anywhere in the field tree) are
    the only reserved keys.

    Raises :class:`AutonomaError(INVALID_BODY)` if the payload references
    an alias that is never declared, or if the alias graph contains a
    cycle.
    """
    if not isinstance(create, dict):
        raise invalid_body("`create` must be an object keyed by model name")

    # First pass: assign temp ids and collect alias declarations.
    raw_entries: list[tuple[str, str, dict[str, Any], str | None]] = []
    counter = 0
    aliases: dict[str, str] = {}
    alias_owner_model: dict[str, str] = {}

    for model, entities in create.items():
        if not isinstance(entities, list):
            raise invalid_body(
                f'`create.{model}` must be a list of entity objects, got {type(entities).__name__}'
            )
        for entity in entities:
            if not isinstance(entity, dict):
                raise invalid_body(
                    f'`create.{model}` entries must be objects, got {type(entity).__name__}'
                )
            temp_id = f"__temp_{model}_{counter}"
            counter += 1
            alias = entity.get("_alias")
            if isinstance(alias, str):
                if alias in aliases:
                    raise invalid_body(f'duplicate _alias "{alias}"')
                aliases[alias] = temp_id
                alias_owner_model[alias] = model
            elif alias is not None:
                raise invalid_body('"_alias" must be a string')
            raw_entries.append((model, temp_id, entity, alias if isinstance(alias, str) else None))

    # Second pass: collect each entry's dependency aliases (for the topo
    # graph) and strip reserved keys from its field dict.
    deps_by_temp_id: dict[str, list[str]] = {}
    fields_by_temp_id: dict[str, dict[str, Any]] = {}
    model_by_temp_id: dict[str, str] = {}
    alias_by_temp_id: dict[str, str | None] = {}

    for model, temp_id, entity, alias in raw_entries:
        deps: list[str] = []
        cleaned: dict[str, Any] = {}
        for key, value in entity.items():
            if key in _RESERVED_KEYS:
                continue
            _collect_refs(value, deps)
            # Rewrite every `{"_ref": alias}` to the alias's temp id. The
            # handler later swaps temp ids for the real factory-returned
            # ids during ``up``.
            cleaned[key] = _resolve_refs(value, aliases)
        unknown = [a for a in deps if a not in aliases]
        if unknown:
            raise invalid_body(
                f'`create.{model}` references unknown alias(es): {", ".join(sorted(set(unknown)))}'
            )
        deps_by_temp_id[temp_id] = deps
        fields_by_temp_id[temp_id] = cleaned
        model_by_temp_id[temp_id] = model
        alias_by_temp_id[temp_id] = alias

    # Build the temp_id graph and topo-sort.
    in_degree: dict[str, int] = {tid: 0 for tid, _, _, _ in [(t, m, e, a) for m, t, e, a in raw_entries]}
    in_degree = {temp_id: 0 for _model, temp_id, _entity, _alias in raw_entries}
    edges: dict[str, list[str]] = defaultdict(list)
    for temp_id, deps in deps_by_temp_id.items():
        seen: set[str] = set()
        for dep_alias in deps:
            dep_temp_id = aliases[dep_alias]
            if dep_temp_id == temp_id or dep_temp_id in seen:
                continue
            seen.add(dep_temp_id)
            edges[dep_temp_id].append(temp_id)
            in_degree[temp_id] += 1

    # Kahn's, preserving payload order as the stable tie-breaker.
    payload_order: dict[str, int] = {
        temp_id: idx for idx, (_m, temp_id, _e, _a) in enumerate(raw_entries)
    }
    ready = sorted(
        [tid for tid, deg in in_degree.items() if deg == 0],
        key=lambda t: payload_order[t],
    )
    sorted_temp_ids: list[str] = []
    while ready:
        tid = ready.pop(0)
        sorted_temp_ids.append(tid)
        for nxt in edges.get(tid, []):
            in_degree[nxt] -= 1
            if in_degree[nxt] == 0:
                ready.append(nxt)
        ready.sort(key=lambda t: payload_order[t])

    if len(sorted_temp_ids) != len(payload_order):
        cycle = sorted(
            [tid for tid, deg in in_degree.items() if deg > 0],
            key=lambda t: payload_order[t],
        )
        cycle_models = ", ".join(model_by_temp_id[t] for t in cycle)
        raise invalid_body(f"cycle detected in _alias/_ref graph: {cycle_models}")

    # Build CreateOp list in topo order.
    tree = ResolvedTree()
    tree.aliases = aliases
    tree.alias_owner_model = alias_owner_model
    tree.alias_dependencies = {
        alias: [d for d in deps_by_temp_id[aliases[alias]]]
        for alias in aliases
    }
    for tid in sorted_temp_ids:
        tree.ops.append(
            CreateOp(
                model=model_by_temp_id[tid],
                fields=fields_by_temp_id[tid],
                temp_id=tid,
            )
        )
    return tree


# ---------------------------------------------------------------------------
# Teardown ordering
# ---------------------------------------------------------------------------


def compute_teardown_order(
    refs: dict[str, list[dict[str, Any]]],
    alias_dependencies: dict[str, list[str]] | None,
    alias_owner_model: dict[str, str] | None,
) -> list[str]:
    """Order models for teardown.

    With ``alias_dependencies`` available (newer refs tokens carry it),
    we run the same Kahn's topo sort over models — derived from
    aggregating each alias's dependencies — and return the *reverse*
    topo so children are torn down before parents.

    Without it (older refs tokens), fall back to reversing the
    insertion order of ``refs`` keys, which is what the SDK always did
    for factory teardown.
    """
    models = list(refs.keys())

    if not alias_dependencies or not alias_owner_model:
        return list(reversed(models))

    # Build model→{model dependencies} by aggregating per-alias edges.
    model_deps: dict[str, set[str]] = {m: set() for m in models}
    for alias, deps in alias_dependencies.items():
        owner = alias_owner_model.get(alias)
        if owner is None or owner not in model_deps:
            continue
        for dep_alias in deps:
            dep_model = alias_owner_model.get(dep_alias)
            if dep_model is None or dep_model == owner:
                continue
            if dep_model in model_deps:
                model_deps[owner].add(dep_model)

    # Kahn's over models. "owner depends on dep_model" means dep_model
    # must be created before owner, so the edge goes ``dep_model → owner``
    # — owner gains in-degree, and parents (dep_model) come out of
    # Kahn's first. Reversing the up-order yields the teardown order.
    in_degree: dict[str, int] = {m: 0 for m in models}
    adj: dict[str, list[str]] = defaultdict(list)
    for owner, deps in model_deps.items():
        for dep_model in deps:
            adj[dep_model].append(owner)
            in_degree[owner] += 1

    payload_order = {m: i for i, m in enumerate(models)}
    ready = sorted([m for m, d in in_degree.items() if d == 0], key=lambda m: payload_order[m])
    up_order: list[str] = []
    while ready:
        m = ready.pop(0)
        up_order.append(m)
        for nxt in adj.get(m, []):
            in_degree[nxt] -= 1
            if in_degree[nxt] == 0:
                ready.append(nxt)
        ready.sort(key=lambda m: payload_order[m])

    if len(up_order) != len(models):
        # Shouldn't happen — cycles are rejected at `up`. Fall back to
        # registration order to avoid losing data.
        return list(reversed(models))

    return list(reversed(up_order))
