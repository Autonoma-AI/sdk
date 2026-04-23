# frozen_string_literal: true

require "set"
require_relative "types"
require_relative "graph"

module Autonoma
  module Teardown
    # Compute the teardown order for models (reverse topological order).
    # Returns a hash with:
    #   :order - array of model names in deletion order (excluding scope root)
    #   :scope_root_model - the scope root model name (deleted last)
    #   :cycles - list of cycle arrays
    #   :scope_field_by_model - map of model -> FK field pointing to scope root
    #   :edge_dicts - edge list in dict format for graph module
    def self.compute_teardown_order(schema)
      edge_dicts = schema.edges.map do |e|
        {
          "from" => e.from_model, "to" => e.to_model,
          "localField" => e.local_field, "foreignField" => e.foreign_field,
          "nullable" => e.nullable
        }
      end

      scope_root_model = nil
      schema.edges.each do |edge|
        if edge.local_field.downcase == schema.scope_field.downcase && edge.to_model != edge.from_model
          scope_root_model = edge.to_model
          break
        end
      end

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

      # Build condensation graph
      components = []
      node_to_comp = {}

      cycles.each do |cycle|
        idx = components.length
        components << cycle
        cycle.each { |node| node_to_comp[node] = idx }
      end
      sorted_models.each do |node|
        node_to_comp[node] = components.length
        components << [node]
      end

      cond_adj = Array.new(components.length) { Set.new }
      cond_in_deg = Array.new(components.length, 0)
      edge_dicts.each do |edge|
        next if edge["from"] == edge["to"]
        fc = node_to_comp[edge["from"]]
        tc = node_to_comp[edge["to"]]
        next if fc.nil? || tc.nil? || fc == tc || cond_adj[tc].include?(fc)
        cond_adj[tc].add(fc)
        cond_in_deg[fc] += 1
      end

      cond_queue = cond_in_deg.each_with_index.select { |d, _| d == 0 }.map { |_, i| i }.sort
      cond_order = []
      until cond_queue.empty?
        cond_queue.sort!
        idx = cond_queue.shift
        cond_order << idx
        cond_adj[idx].each do |neighbor|
          cond_in_deg[neighbor] -= 1
          cond_queue << neighbor if cond_in_deg[neighbor] == 0
        end
      end

      order = []
      cond_order.reverse_each do |comp_idx|
        components[comp_idx].each do |model|
          order << model unless model == scope_root_model
        end
      end

      {
        order: order,
        scope_root_model: scope_root_model,
        cycles: cycles,
        scope_field_by_model: scope_field_by_model,
        edge_dicts: edge_dicts
      }
    end

    # Delete all data scoped to scope_value in reverse topological order.
    def self.teardown(executor, dialect, table_map, column_maps, schema, scope_value, refs = nil, skip_models: nil)
      td = compute_teardown_order(schema)
      scope_root_model = td[:scope_root_model]
      cycles = td[:cycles]
      scope_field_by_model = td[:scope_field_by_model]
      edge_dicts = td[:edge_dicts]
      order = td[:order]

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

        # Delete in order, skipping factory-teardown models
        order.each do |model|
          next if skip_models&.include?(model)
          delete_model(tx, dialect, table_map, column_maps, model,
                       scope_value, scope_field_by_model, refs, schema)
        end

        # Delete scope root last (unless skipped by factory teardown)
        if scope_root_model && !(skip_models&.include?(scope_root_model))
          db_table = table_map[scope_root_model]
          col_map = column_maps[scope_root_model] || {}
          if db_table
            root_model_info = schema.models.find { |m| m.name == scope_root_model }
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
