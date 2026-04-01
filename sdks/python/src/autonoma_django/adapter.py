"""Autonoma SDK — Django ORM adapter."""

from __future__ import annotations

from typing import Any, Optional

from autonoma.graph import topo_sort, find_deferrable_edge


class DjangoAdapter:
    """Django ORM adapter for the Autonoma SDK.

    Usage::

        from autonoma_django import DjangoAdapter
        adapter = DjangoAdapter([Organization, User, Application], scope_field="organization_id")
    """

    name = "django"

    def __init__(self, models: list[type[Any]], scope_field: str = "organization_id") -> None:
        self._models: list[type[Any]] = models
        self._scope_field: str = scope_field
        self._model_map: dict[str, type[Any]] = {m.__name__: m for m in models}
        self._cached_schema: Optional[dict[str, Any]] = None

    def get_schema(self) -> dict[str, Any]:
        if self._cached_schema is not None:
            return self._cached_schema

        models_info: list[dict[str, Any]] = []
        edges: list[dict[str, Any]] = []
        relations: list[dict[str, str]] = []

        for model in self._models:
            meta = model._meta
            fields: list[dict[str, Any]] = []

            for field in meta.get_fields():
                # Skip reverse relations
                if field.is_relation and not field.concrete:
                    continue

                field_info: dict[str, Any] = {
                    "name": field.column if hasattr(field, "column") else field.name,
                    "type": type(field).__name__,
                    "isRequired": not getattr(field, "null", True),
                    "isId": getattr(field, "primary_key", False),
                    "hasDefault": (
                        getattr(field, "has_default", lambda: False)()
                        if callable(getattr(field, "has_default", None))
                        else bool(getattr(field, "default", None) is not None)
                    ),
                }
                fields.append(field_info)

                # FK edges
                if field.is_relation and hasattr(field, "related_model") and field.related_model:
                    target_model: type[Any] = field.related_model
                    if target_model.__name__ in self._model_map:
                        edges.append({
                            "from": model.__name__,
                            "to": target_model.__name__,
                            "localField": field.column,
                            "foreignField": target_model._meta.pk.column if target_model._meta.pk else "id",
                            "nullable": getattr(field, "null", False),
                        })

            models_info.append({"name": model.__name__, "fields": fields})

        self._cached_schema = {
            "models": models_info,
            "edges": edges,
            "relations": relations,
            "scopeField": self._scope_field,
        }
        return self._cached_schema

    async def create_entities(self, spec: dict[str, Any], context: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
        from asgiref.sync import sync_to_async
        return await sync_to_async(self._create_entities_sync)(spec, context)

    def _create_entities_sync(self, spec: dict[str, Any], context: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
        from django.db import transaction

        results: dict[str, list[dict[str, Any]]] = {}

        with transaction.atomic():
            for model_name, entity_spec in spec.items():
                model_cls: type[Any] | None = self._model_map.get(model_name)
                if model_cls is None:
                    raise ValueError(f"Unknown model: {model_name}")

                created: list[dict[str, Any]] = []
                for field_data in entity_spec.get("fields", []):
                    instance = model_cls(**field_data)
                    instance.save()
                    created.append(self._instance_to_dict(instance))

                results[model_name] = created

        return results

    async def teardown(self, scope_value: str, refs: Optional[dict[str, Any]] = None) -> None:
        from asgiref.sync import sync_to_async
        return await sync_to_async(self._teardown_sync)(scope_value, refs)

    def _teardown_sync(self, scope_value: str, refs: Optional[dict[str, Any]] = None) -> None:
        from django.db import transaction

        schema: dict[str, Any] = self.get_schema()
        model_names: list[str] = [m["name"] for m in schema["models"]]
        result: dict[str, Any] = topo_sort(model_names, schema["edges"])
        sorted_models: list[str] = result["sorted"]
        cycles: list[list[str]] = result["cycles"]

        scope_root: str | None = None
        for edge in schema["edges"]:
            if edge["localField"] == self._scope_field and edge["to"] != edge["from"]:
                scope_root = edge["to"]
                break

        scope_fk_by_model: dict[str, str] = {}
        if scope_root:
            for edge in schema["edges"]:
                if edge["to"] == scope_root and edge["from"] != scope_root:
                    scope_fk_by_model[edge["from"]] = edge["localField"]

        with transaction.atomic():
            # Break cycles
            for cycle in cycles:
                edge = find_deferrable_edge(cycle, schema["edges"])
                if edge:
                    model_cls: type[Any] | None = self._model_map.get(edge["from"])
                    scope_fk: str | None = scope_fk_by_model.get(edge["from"])
                    if model_cls and scope_fk:
                        model_cls.objects.filter(**{scope_fk: scope_value}).update(**{edge["localField"]: None})

            # Delete cycle nodes
            for cycle in cycles:
                for model_name in cycle:
                    self._delete_model(model_name, scope_value, scope_fk_by_model, scope_root, refs)

            # Delete in reverse topo order
            for model_name in reversed(sorted_models):
                if model_name == scope_root:
                    continue
                self._delete_model(model_name, scope_value, scope_fk_by_model, scope_root, refs)

            # Delete scope root last
            if scope_root:
                model_cls = self._model_map.get(scope_root)
                if model_cls:
                    model_cls.objects.filter(pk=scope_value).delete()

    def _delete_model(
        self,
        model_name: str,
        scope_value: str,
        scope_fk_by_model: dict[str, str],
        scope_root: str | None,
        refs: Optional[dict[str, Any]],
    ) -> None:
        model_cls: type[Any] | None = self._model_map.get(model_name)
        if not model_cls:
            return

        scope_fk: str | None = scope_fk_by_model.get(model_name)
        if scope_fk:
            model_cls.objects.filter(**{scope_fk: scope_value}).delete()
        elif refs and model_name in refs:
            ids: list[Any] = [r.get("id") for r in refs[model_name] if r.get("id")]
            if ids:
                model_cls.objects.filter(pk__in=ids).delete()

    def _instance_to_dict(self, instance: Any) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for field in instance._meta.get_fields():
            if field.is_relation and not field.concrete:
                continue
            col: str = field.column if hasattr(field, "column") else field.name
            result[col] = getattr(instance, field.attname if hasattr(field, "attname") else field.name, None)
        return result
