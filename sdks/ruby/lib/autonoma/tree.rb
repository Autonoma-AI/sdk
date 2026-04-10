# frozen_string_literal: true

require "set"
require_relative "types"

module Autonoma
  class ResolvedTree
    attr_accessor :ops, :deferred_updates, :aliases

    def initialize
      @ops = []
      @deferred_updates = []
      @aliases = {}
    end
  end

  module Tree
    RESERVED_KEYS = Set.new(%w[_alias _ref]).freeze

    # Convert nested scenario tree into flat, ordered CreateOp list.
    def self.resolve_tree(create, schema)
      relation_by_parent_field = {}
      schema.relations.each do |rel|
        relation_by_parent_field["#{rel.parent_model}.#{rel.parent_field}"] = rel
      end

      # Determine FK direction for each relation
      fk_on_parent = Set.new
      schema.relations.each do |rel|
        schema.edges.each do |edge|
          if edge.local_field == rel.child_field &&
             (edge.from_model == rel.parent_model || edge.from_model == rel.child_model)
            fk_on_parent.add("#{rel.parent_model}.#{rel.parent_field}") if edge.from_model == rel.parent_model
            break
          end
        end
      end

      result = ResolvedTree.new
      temp_counter = [0]

      make_temp_id = lambda do |model|
        tid = "__temp_#{model}_#{temp_counter[0]}"
        temp_counter[0] += 1
        tid
      end

      walk_node = nil
      walk_node = lambda do |model_name, node, parent_temp_id, parent_relation, parent_fk_on_parent|
        fields = {}
        pre_children = []
        post_children = []
        aliaz = node["_alias"]
        temp_id = make_temp_id.call(model_name)

        node.each do |key, value|
          next if RESERVED_KEYS.include?(key)

          # Look up relation
          exact_key = "#{model_name}.#{key}"
          lm = model_name[0].downcase + model_name[1..]
          prefixed_key = "#{model_name}.#{lm}#{key[0].upcase}#{key[1..]}"

          relation = relation_by_parent_field[exact_key] || relation_by_parent_field[prefixed_key]
          matched_key = relation_by_parent_field.key?(exact_key) ? exact_key : prefixed_key

          unless relation
            # Fallback: match by child model name
            relation_by_parent_field.each do |rel_key, rel|
              if rel_key.start_with?("#{model_name}.") && rel.child_model.downcase == key.downcase
                relation = rel
                matched_key = rel_key
                break
              end
            end
          end

          if relation
            is_on_parent = fk_on_parent.include?(matched_key)
            if is_on_parent
              pre_children << [relation, value, true]
            else
              post_children << [relation, value, false]
            end
            next
          end

          # Handle _ref
          if value.is_a?(Hash) && value.key?("_ref")
            ref_alias = value["_ref"]
            ref_temp_id = result.aliases[ref_alias]
            unless ref_temp_id
              result.deferred_updates << DeferredUpdate.new(
                target_temp_id: temp_id,
                model: model_name,
                field: key,
                ref_alias: ref_alias
              )
              next
            end
            fields[key] = ref_temp_id
            next
          end

          fields[key] = value
        end

        # Wire FK to parent
        if parent_relation && parent_temp_id && !parent_fk_on_parent
          fields[parent_relation.child_field] = parent_temp_id
        end

        # Process pre-children
        pre_children.each do |relation, value, _is_on_parent|
          if value.is_a?(Array)
            value.each_with_index do |child_node, _i|
              child_temp_id = walk_node.call(relation.child_model, child_node, temp_id, relation, true)
              fields[relation.child_field] = child_temp_id
            end
          end
        end

        # Create this node
        result.ops << CreateOp.new(model: model_name, fields: fields, temp_id: temp_id, batch: false)
        result.aliases[aliaz] = temp_id if aliaz

        # Process post-children
        post_children.each do |relation, value, _|
          if value.is_a?(Array)
            value.each do |child_node|
              walk_node.call(relation.child_model, child_node, temp_id, relation, false)
            end
          end
        end

        temp_id
      end

      create.each do |model_name, nodes|
        nodes.each do |node|
          walk_node.call(model_name, node, nil, nil, false)
        end
      end

      result
    end
  end
end
