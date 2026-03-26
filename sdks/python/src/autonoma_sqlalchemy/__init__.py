"""Autonoma SDK — SQLAlchemy ORM adapter."""

from __future__ import annotations

from typing import Any, Optional

from sqlalchemy import inspect as sa_inspect

from autonoma.graph import topo_sort, find_deferrable_edge


class SQLAlchemyAdapter:
    """SQLAlchemy ORM adapter for the Autonoma SDK.

    Usage::

        from autonoma_sqlalchemy import SQLAlchemyAdapter
        adapter = SQLAlchemyAdapter(SessionLocal, [Organization, User, App], scope_field="organization_id")
    """

    name = "sqlalchemy"

    def __init__(self, session_factory, models: list, scope_field: str = "organization_id"):
        self._session_factory = session_factory
        self._models = models
        self._scope_field = scope_field
        self._model_map: dict[str, Any] = {m.__name__: m for m in models}
        self._cached_schema: Optional[dict] = None

    def get_schema(self) -> dict:
        if self._cached_schema is not None:
            return self._cached_schema

        models_info = []
        edges = []
        relations = []

        for model in self._models:
            mapper = sa_inspect(model)
            fields = []
            for col in mapper.columns:
                fields.append({
                    "name": col.name,
                    "type": str(col.type),
                    "isRequired": not col.nullable,
                    "isId": col.primary_key,
                    "hasDefault": (
                        col.default is not None
                        or col.server_default is not None
                        or bool(col.autoincrement and col.autoincrement is not False)
                    ),
                })

            models_info.append({"name": model.__name__, "fields": fields})

            # FK edges from foreign key constraints
            for fk_constraint in model.__table__.foreign_key_constraints:
                local_cols = list(fk_constraint.columns)
                remote_cols = list(fk_constraint.elements)
                if local_cols and remote_cols:
                    local_col = local_cols[0]
                    remote_col = remote_cols[0]
                    # Find the target model name (PascalCase) from the table name
                    target_table = remote_col.column.table.name
                    target_model_name = self._table_to_model_name(target_table)
                    edges.append({
                        "from": model.__name__,
                        "to": target_model_name,
                        "localField": local_col.name,
                        "foreignField": remote_col.column.name,
                        "nullable": local_col.nullable,
                    })

            # Relations from relationship() definitions
            for rel in mapper.relationships:
                if rel.direction.name == "MANYTOONE":
                    # This model holds the FK
                    local_pairs = list(rel.local_columns)
                    if local_pairs:
                        local_col_name = list(rel.local_columns)[0].name
                        relations.append({
                            "parentModel": model.__name__,
                            "childModel": rel.mapper.class_.__name__,
                            "parentField": rel.key,
                            "childField": local_col_name,
                        })

        self._cached_schema = {
            "models": models_info,
            "edges": edges,
            "relations": relations,
            "scopeField": self._scope_field,
        }
        return self._cached_schema

    async def create_entities(self, spec: dict, context: dict) -> dict:
        """Create entities in the database. spec maps model names to {fields: [...], batch: bool}."""
        session = self._session_factory()
        results: dict[str, list[dict]] = {}

        try:
            for model_name, entity_spec in spec.items():
                model_cls = self._model_map.get(model_name)
                if model_cls is None:
                    raise ValueError(f"Unknown model: {model_name}")

                created = []
                for field_data in entity_spec.get("fields", []):
                    instance = model_cls(**field_data)
                    session.add(instance)
                    session.flush()
                    created.append(self._instance_to_dict(instance))

                results[model_name] = created

            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

        return results

    async def teardown(self, scope_value: str, refs: Optional[dict] = None) -> None:
        """Delete all data scoped to scope_value in reverse topological order."""
        schema = self.get_schema()
        model_names = [m["name"] for m in schema["models"]]
        result = topo_sort(model_names, schema["edges"])
        sorted_models = result["sorted"]
        cycles = result["cycles"]

        # Find scope root model (model that scope FK points TO)
        scope_root = None
        for edge in schema["edges"]:
            if edge["localField"] == self._scope_field and edge["to"] != edge["from"]:
                scope_root = edge["to"]
                break

        # Build map: model -> FK field that points to scope root
        scope_fk_by_model: dict[str, str] = {}
        if scope_root:
            for edge in schema["edges"]:
                if edge["to"] == scope_root and edge["from"] != scope_root:
                    scope_fk_by_model[edge["from"]] = edge["localField"]

        session = self._session_factory()
        try:
            # Break cycles by nullifying deferrable edges
            for cycle in cycles:
                edge = find_deferrable_edge(cycle, schema["edges"])
                if edge:
                    model_cls = self._model_map.get(edge["from"])
                    scope_fk = scope_fk_by_model.get(edge["from"])
                    if model_cls and scope_fk:
                        session.query(model_cls).filter(
                            getattr(model_cls, scope_fk) == scope_value
                        ).update({edge["localField"]: None})

            # Delete cycle nodes
            for cycle in cycles:
                for model_name in cycle:
                    self._delete_model(session, model_name, scope_value, scope_fk_by_model, scope_root, refs)

            # Delete in reverse topo order
            for model_name in reversed(sorted_models):
                if model_name == scope_root:
                    continue
                self._delete_model(session, model_name, scope_value, scope_fk_by_model, scope_root, refs)

            # Delete scope root last
            if scope_root:
                model_cls = self._model_map.get(scope_root)
                if model_cls:
                    pk_col = sa_inspect(model_cls).primary_key[0]
                    session.query(model_cls).filter(pk_col == scope_value).delete()

            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    def _delete_model(self, session, model_name: str, scope_value: str,
                      scope_fk_by_model: dict, scope_root: Optional[str],
                      refs: Optional[dict]) -> None:
        model_cls = self._model_map.get(model_name)
        if not model_cls:
            return

        scope_fk = scope_fk_by_model.get(model_name)
        if scope_fk:
            session.query(model_cls).filter(
                getattr(model_cls, scope_fk) == scope_value
            ).delete()
        elif refs and model_name in refs:
            ids = [r.get("id") for r in refs[model_name] if r.get("id")]
            if ids:
                pk_col = sa_inspect(model_cls).primary_key[0]
                session.query(model_cls).filter(pk_col.in_(ids)).delete()

    def _table_to_model_name(self, table_name: str) -> str:
        """Map a table name back to a model class name."""
        for model in self._models:
            if model.__table__.name == table_name:
                return model.__name__
        return table_name

    def _instance_to_dict(self, instance) -> dict:
        """Convert a SQLAlchemy model instance to a dict."""
        mapper = sa_inspect(type(instance))
        return {col.name: getattr(instance, col.name) for col in mapper.columns}
