# frozen_string_literal: true

module Autonoma
  module PayloadTopo
    # Output of resolve_payload_tree.
    class ResolvedTree
      attr_accessor :ops, :aliases, :alias_owner_model, :alias_dependencies

      def initialize
        @ops = []
        @aliases = {}
        @alias_owner_model = {}
        @alias_dependencies = {}
      end
    end

    RESERVED_KEYS = Set.new(%w[_alias _ref]).freeze

    # Walk a field value tree and append every _ref alias found.
    def self.collect_refs(value, out)
      case value
      when Hash
        ref = value["_ref"]
        if ref.is_a?(String)
          out << ref
          return
        end
        value.each_value { |v| collect_refs(v, out) }
      when Array
        value.each { |v| collect_refs(v, out) }
      end
    end

    # Replace each {"_ref": alias} with its temp id.
    def self.resolve_refs(value, alias_to_temp_id)
      case value
      when Hash
        ref = value["_ref"]
        if ref.is_a?(String)
          real = alias_to_temp_id[ref]
          return real.nil? ? value : real
        end
        value.each_with_object({}) { |(k, v), out| out[k] = resolve_refs(v, alias_to_temp_id) }
      when Array
        value.map { |v| resolve_refs(v, alias_to_temp_id) }
      else
        value
      end
    end

    # Topo-sort a create payload into an ordered list of CreateOp.
    def self.resolve_payload_tree(create)
      unless create.is_a?(Hash)
        raise Errors.invalid_body("`create` must be an object keyed by model name")
      end

      # First pass: assign temp ids and collect alias declarations.
      raw_entries = [] # [model, temp_id, entity, alias_name]
      counter = 0
      aliases = {}
      alias_owner_model = {}

      create.each do |model, entities|
        unless entities.is_a?(Array)
          raise Errors.invalid_body(
            "`create.#{model}` must be a list of entity objects, got #{entities.class.name}"
          )
        end

        entities.each do |entity|
          unless entity.is_a?(Hash)
            raise Errors.invalid_body(
              "`create.#{model}` entries must be objects, got #{entity.class.name}"
            )
          end

          temp_id = "__temp_#{model}_#{counter}"
          counter += 1

          alias_name = entity["_alias"]
          if alias_name.is_a?(String)
            if aliases.key?(alias_name)
              raise Errors.invalid_body("duplicate _alias \"#{alias_name}\"")
            end
            aliases[alias_name] = temp_id
            alias_owner_model[alias_name] = model
          elsif !alias_name.nil?
            raise Errors.invalid_body('"_alias" must be a string')
          end

          raw_entries << [model, temp_id, entity, alias_name.is_a?(String) ? alias_name : nil]
        end
      end

      # Second pass: collect dependencies and strip reserved keys.
      deps_by_temp_id = {}
      fields_by_temp_id = {}
      model_by_temp_id = {}
      alias_by_temp_id = {}

      raw_entries.each do |model, temp_id, entity, alias_name|
        deps = []
        cleaned = {}

        entity.each do |key, value|
          next if RESERVED_KEYS.include?(key)

          collect_refs(value, deps)
          cleaned[key] = resolve_refs(value, aliases)
        end

        unknown = deps.select { |a| !aliases.key?(a) }.uniq.sort
        unless unknown.empty?
          raise Errors.invalid_body(
            "`create.#{model}` references unknown alias(es): #{unknown.join(", ")}"
          )
        end

        deps_by_temp_id[temp_id] = deps
        fields_by_temp_id[temp_id] = cleaned
        model_by_temp_id[temp_id] = model
        alias_by_temp_id[temp_id] = alias_name
      end

      # Build the temp_id graph and topo-sort.
      in_degree = {}
      raw_entries.each { |_, temp_id, _, _| in_degree[temp_id] = 0 }

      edges = Hash.new { |h, k| h[k] = [] }

      deps_by_temp_id.each do |temp_id, deps|
        seen = Set.new
        deps.each do |dep_alias|
          dep_temp_id = aliases[dep_alias]
          next if dep_temp_id == temp_id || seen.include?(dep_temp_id)

          seen.add(dep_temp_id)
          edges[dep_temp_id] << temp_id
          in_degree[temp_id] += 1
        end
      end

      # Kahn's, preserving payload order as the stable tie-breaker.
      payload_order = {}
      raw_entries.each_with_index { |(_, temp_id, _, _), idx| payload_order[temp_id] = idx }

      ready = in_degree.select { |_, d| d == 0 }.keys.sort_by { |t| payload_order[t] }
      sorted_temp_ids = []

      until ready.empty?
        tid = ready.shift
        sorted_temp_ids << tid
        (edges[tid] || []).each do |nxt|
          in_degree[nxt] -= 1
          ready << nxt if in_degree[nxt] == 0
        end
        ready.sort_by! { |t| payload_order[t] }
      end

      if sorted_temp_ids.length != payload_order.length
        cycle = in_degree.select { |_, d| d > 0 }.keys.sort_by { |t| payload_order[t] }
        cycle_models = cycle.map { |t| model_by_temp_id[t] }.join(", ")
        raise Errors.invalid_body("cycle detected in _alias/_ref graph: #{cycle_models}")
      end

      # Build the result.
      tree = ResolvedTree.new
      tree.aliases = aliases
      tree.alias_owner_model = alias_owner_model
      tree.alias_dependencies = aliases.each_with_object({}) do |(alias_name, temp_id), h|
        h[alias_name] = deps_by_temp_id[temp_id] || []
      end

      sorted_temp_ids.each do |tid|
        tree.ops << CreateOp.new(
          model: model_by_temp_id[tid],
          fields: fields_by_temp_id[tid],
          temp_id: tid
        )
      end

      tree
    end

    # Order models for teardown.
    def self.compute_teardown_order(refs, alias_dependencies, alias_owner_model)
      models = refs.keys

      if alias_dependencies.nil? || alias_dependencies.empty? ||
         alias_owner_model.nil? || alias_owner_model.empty?
        return models.reverse
      end

      # Build model-level dependency graph.
      model_deps = models.each_with_object({}) { |m, h| h[m] = Set.new }

      alias_dependencies.each do |alias_name, deps|
        owner = alias_owner_model[alias_name]
        next if owner.nil? || !model_deps.key?(owner)

        deps.each do |dep_alias|
          dep_model = alias_owner_model[dep_alias]
          next if dep_model.nil? || dep_model == owner || !model_deps.key?(dep_model)

          model_deps[owner].add(dep_model)
        end
      end

      # Kahn's over models.
      in_degree = models.each_with_object({}) { |m, h| h[m] = 0 }
      adj = Hash.new { |h, k| h[k] = [] }

      model_deps.each do |owner, deps|
        deps.each do |dep_model|
          adj[dep_model] << owner
          in_degree[owner] += 1
        end
      end

      payload_order = models.each_with_index.to_h
      ready = in_degree.select { |_, d| d == 0 }.keys.sort_by { |m| payload_order[m] }
      up_order = []

      until ready.empty?
        m = ready.shift
        up_order << m
        (adj[m] || []).each do |nxt|
          in_degree[nxt] -= 1
          ready << nxt if in_degree[nxt] == 0
        end
        ready.sort_by! { |m2| payload_order[m2] }
      end

      # Fall back to reversed insertion order if cycle detected (shouldn't happen).
      return models.reverse if up_order.length != models.length

      up_order.reverse
    end

    private_class_method :collect_refs, :resolve_refs
  end
end
