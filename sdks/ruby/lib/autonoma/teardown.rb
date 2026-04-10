# frozen_string_literal: true

require_relative "types"
require_relative "graph"

module Autonoma
  module Teardown
    # Delete all data scoped to scope_value in reverse topological order.
    def self.teardown(executor, dialect, table_map, column_maps, schema, scope_value, refs = nil)
      # Convert edges to dict format for graph module
      edge_dicts = schema.edges.map do |e|
        {
          "from" => e.from_model, "to" => e.to_model,
          "localField" => e.local_field, "foreignField" => e.foreign_field,
          "nullable" => e.nullable
        }
      end

      # Find scope root model
      scope_root_model = nil
      schema.edges.each do |edge|
        if edge.local_field.downcase == schema.scope_field.downcase && edge.to_model != edge.from_model
          scope_root_model = edge.to_model
          break
        end
      end

      # Build map: model -> FK field pointing to scope root
      scope_field_by_model = {}
      if scope_root_model
        schema.edges.each do |edge|
          if edge.to_model == scope_root_model && edge.from_model != scope_root_model
            scope_field_by_model[edge.from_model] = edge.local_field
          end
        end
      end

      model_names = schema.models.map(&:name)
      result = Graph.topo_sort(model_names, edge_dicts)
      sorted_models = result["sorted"]
      cycles = result["cycles"]

      executor.transaction do |tx|
        # Break cycles by nullifying deferrable FKs
        cycles.each do |cycle|
          edge = Graph.find_deferrable_edge(cycle, edge_dicts)
          next unless edge

          scope_fk = scope_field_by_model[edge["from"]]
          next unless scope_fk

          db_table = table_map[edge["from"]]
          col_map = column_maps[edge["from"]] || {}
          next unless db_table

          db_fk_col = col_map[edge["localField"]] || edge["localField"]
          db_scope_col = col_map[scope_fk] || scope_fk
          tx.query(
            "UPDATE #{dialect.quote_id(db_table)} SET #{dialect.quote_id(db_fk_col)} = NULL " \
            "WHERE #{dialect.quote_id(db_scope_col)} = #{dialect.param(1)}",
            [scope_value]
          )
        end

        # Delete non-cycle nodes in reverse topo order first (dependents before cycle nodes)
        sorted_models.reverse_each do |model|
          next if model == scope_root_model

          delete_model(tx, dialect, table_map, column_maps, model,
                       scope_value, scope_field_by_model, refs, schema)
        end

        # Delete cycle nodes after their non-cycle dependents are gone
        cycles.each do |cycle|
          cycle.each do |model|
            delete_model(tx, dialect, table_map, column_maps, model,
                         scope_value, scope_field_by_model, refs, schema)
          end
        end

        # Delete scope root last
        if scope_root_model
          db_table = table_map[scope_root_model]
          col_map = column_maps[scope_root_model] || {}
          if db_table
            root_model_info = schema.models.find { |m| m.name == scope_root_model }
            root_pk_field_name = root_model_info&.fields&.find { |f| f.is_id }&.name || "id"
            id_col = col_map[root_pk_field_name] || root_pk_field_name
            tx.query(
              "DELETE FROM #{dialect.quote_id(db_table)} WHERE #{dialect.quote_id(id_col)} = #{dialect.param(1)}",
              [scope_value]
            )
          end
        end
      end
    end

    def self.delete_model(tx, dialect, table_map, column_maps, model, scope_value, scope_field_by_model, refs, schema)
      db_table = table_map[model]
      return unless db_table

      col_map = column_maps[model] || {}

      # Find actual PK field name from schema
      model_info = schema.models.find { |m| m.name == model }
      pk_field_name = model_info&.fields&.find { |f| f.is_id }&.name || "id"

      scope_fk = scope_field_by_model[model]
      if scope_fk
        db_col = col_map[scope_fk] || scope_fk
        tx.query(
          "DELETE FROM #{dialect.quote_id(db_table)} WHERE #{dialect.quote_id(db_col)} = #{dialect.param(1)}",
          [scope_value]
        )
      elsif refs && refs[model]
        ids = refs[model].map { |r| r[pk_field_name] }.compact
        if ids.any?
          id_col = col_map[pk_field_name] || pk_field_name
          placeholders = ids.each_with_index.map { |_, i| dialect.param(i + 1) }.join(", ")
          tx.query(
            "DELETE FROM #{dialect.quote_id(db_table)} WHERE #{dialect.quote_id(id_col)} IN (#{placeholders})",
            ids
          )
        end
      end
    end

    private_class_method :delete_model
  end
end
