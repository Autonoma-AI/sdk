"""Resolve a nested scenario tree into an ordered list of create operations."""

from __future__ import annotations

from typing import Any

from .types import SchemaInfo, SchemaRelation, CreateOp, DeferredUpdate

RESERVED_KEYS = {"_alias", "_ref"}


def _deep_resolve_refs(value: Any, aliases: dict[str, str]) -> Any:
    """Recursively replace `{"_ref": alias}` placeholders inside nested dicts
    and lists with the resolved temp id, so factory inputs keep their nested
    shape (e.g. ``{"data": {"capacity_provider_id": {"_ref": "cp"}}}``).

    Refs whose alias is not yet known are left as-is — the caller decides
    whether to defer or surface an error.
    """
    if isinstance(value, dict):
        if "_ref" in value and isinstance(value["_ref"], str):
            ref_temp_id = aliases.get(value["_ref"])
            if ref_temp_id is not None:
                return ref_temp_id
            return value
        return {k: _deep_resolve_refs(v, aliases) for k, v in value.items()}
    if isinstance(value, list):
        return [_deep_resolve_refs(v, aliases) for v in value]
    return value


class ResolvedTree:
    __slots__ = ("ops", "deferred_updates", "aliases")

    def __init__(self) -> None:
        self.ops: list[CreateOp] = []
        self.deferred_updates: list[DeferredUpdate] = []
        self.aliases: dict[str, str] = {}


def resolve_tree(
    create: dict[str, list[dict[str, Any]]],
    schema: SchemaInfo,
) -> ResolvedTree:
    """Convert nested scenario tree into flat, ordered CreateOp list."""
    relation_by_parent_field: dict[str, SchemaRelation] = {}
    for rel in schema.relations:
        relation_by_parent_field[f"{rel.parent_model}.{rel.parent_field}"] = rel

    # Determine FK direction for each relation
    fk_on_parent: set[str] = set()
    for rel in schema.relations:
        for edge in schema.edges:
            if edge.local_field == rel.child_field and (edge.from_model == rel.parent_model or edge.from_model == rel.child_model):
                if edge.from_model == rel.parent_model:
                    fk_on_parent.add(f"{rel.parent_model}.{rel.parent_field}")
                break

    result = ResolvedTree()
    temp_counter = [0]

    def make_temp_id(model: str) -> str:
        tid = f"__temp_{model}_{temp_counter[0]}"
        temp_counter[0] += 1
        return tid

    def walk_node(
        model_name: str,
        node: dict[str, Any],
        parent_temp_id: str | None,
        parent_relation: SchemaRelation | None,
        parent_fk_on_parent: bool,
    ) -> str:
        fields: dict[str, Any] = {}
        pre_children: list[tuple[SchemaRelation, Any, bool]] = []
        post_children: list[tuple[SchemaRelation, Any, bool]] = []
        alias = node.get("_alias")
        temp_id = make_temp_id(model_name)

        for key, value in node.items():
            if key in RESERVED_KEYS:
                continue

            # Look up relation
            exact_key = f"{model_name}.{key}"
            lm = model_name[0].lower() + model_name[1:]
            prefixed_key = f"{model_name}.{lm}{key[0].upper()}{key[1:]}"

            relation = relation_by_parent_field.get(exact_key) or relation_by_parent_field.get(prefixed_key)
            matched_key = exact_key if exact_key in relation_by_parent_field else prefixed_key

            if not relation:
                # Fallback: match by child model name
                for rel_key, rel in relation_by_parent_field.items():
                    if rel_key.startswith(f"{model_name}.") and rel.child_model.lower() == key.lower():
                        relation = rel
                        matched_key = rel_key
                        break

            if relation:
                is_on_parent = matched_key in fk_on_parent
                if is_on_parent:
                    pre_children.append((relation, value, True))
                else:
                    post_children.append((relation, value, False))
                continue

            # Handle _ref at the top level
            if isinstance(value, dict) and "_ref" in value:
                ref_alias = value["_ref"]
                ref_temp_id = result.aliases.get(ref_alias)
                if not ref_temp_id:
                    result.deferred_updates.append(DeferredUpdate(
                        target_temp_id=temp_id,
                        model=model_name,
                        field=key,
                        ref_alias=ref_alias,
                    ))
                    continue
                fields[key] = ref_temp_id
                continue

            # Handle _ref nested inside dicts/lists (e.g. inside a `data:` blob).
            # Deep-resolve only when an alias is already known; if the alias has
            # not yet been declared, the `_ref` placeholder is left in place
            # because nested refs are not eligible for the deferred-update
            # mechanism (it only patches top-level FK columns).
            fields[key] = _deep_resolve_refs(value, result.aliases)

        # Wire FK to parent
        if parent_relation and parent_temp_id and not parent_fk_on_parent:
            fields[parent_relation.child_field] = parent_temp_id

        # Process pre-children
        for relation, value, is_on_parent in pre_children:
            if isinstance(value, list):
                for i, child_node in enumerate(value):
                    child_temp_id = walk_node(relation.child_model, child_node, temp_id, relation, True)
                    fields[relation.child_field] = child_temp_id

        # Create this node
        result.ops.append(CreateOp(model=model_name, fields=fields, temp_id=temp_id, batch=False))
        if alias:
            result.aliases[alias] = temp_id

        # Process post-children
        for relation, value, _ in post_children:
            if isinstance(value, list):
                for i, child_node in enumerate(value):
                    walk_node(relation.child_model, child_node, temp_id, relation, False)

        return temp_id

    for model_name, nodes in create.items():
        for node in nodes:
            walk_node(model_name, node, None, None, False)

    return result
