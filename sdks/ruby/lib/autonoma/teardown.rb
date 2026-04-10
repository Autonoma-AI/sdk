# frozen_string_literal: true

require "set"
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

        # Partition sorted nodes: those that depend on cycle nodes must be deleted
        # BEFORE cycles, those that cycle nodes depend on must be deleted AFTER.
        cycle_node_set = cycles.flatten.to_set

        if cycle_node_set.any?
          # Build dependency map: node → set of nodes it depends on
          depends_on = {}
          edge_dicts.each do |edge|
            next if edge["from"] == edge["to"]
            (depends_on[edge["from"]] ||= Set.new).add(edge["to"])
          end

          # Mark nodes that transitively depend on cycle nodes
          depends_on_cycle = Set.new
          sorted_models.each do |node|
            deps = depends_on[node] || Set.new
            if deps.any? { |d| cycle_node_set.include?(d) || depends_on_cycle.include?(d) }
              depends_on_cycle.add(node)
            end
          end

          cycle_dependents = sorted_models.select { |n| depends_on_cycle.include?(n) }
          cycle_deps = sorted_models.reject { |n| depends_on_cycle.include?(n) }

          cycle_dependents.reverse_each do |model|
            next if model == scope_root_model
            delete_model(tx, dialect, table_map, column_maps, model,
                         scope_value, scope_field_by_model, refs, schema)
          end

          cycles.each do |cycle|
            cycle.each do |model|
              delete_model(tx, dialect, table_map, column_maps, model,
                           scope_value, scope_field_by_model, refs, schema)
            end
          end

          cycle_deps.reverse_each do |model|
            next if model == scope_root_model
            delete_model(tx, dialect, table_map, column_maps, model,
                         scope_value, scope_field_by_model, refs, schema)
          end
        else
          sorted_models.reverse_each do |model|
            next if model == scope_root_model
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
            # Composite PK: prefer field named "id"
            root_id_fields = root_model_info&.fields&.select { |f| f.is_id } || []
            root_pk_field_name = (root_id_fields.find { |f| f.name.downcase == "id" } || root_id_fields.first)&.name || "id"
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
      # When multiple is_id fields exist (composite PK), prefer the one named "id"
      id_fields = model_info&.fields&.select { |f| f.is_id } || []
      pk_field_name = (id_fields.find { |f| f.name.downcase == "id" } || id_fields.first)&.name || "id"

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
