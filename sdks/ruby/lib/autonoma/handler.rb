# frozen_string_literal: true

require "json"
require "securerandom"
require "time"

require_relative "hmac"
require_relative "refs"
require_relative "errors"
require_relative "types"
require_relative "dialect"
require_relative "introspect"
require_relative "tree"
require_relative "create"
require_relative "teardown"

module Autonoma
  module Handler
    PROTOCOL_VERSION = File.read(File.expand_path("../../../../protocol/version.txt", __dir__)).strip

    def self.handle_request(config, req)
      if config.shared_secret == config.signing_secret
        raise Errors.same_secrets
      end

      unless config.allow_production
        env = ENV["RAILS_ENV"] || ENV["RACK_ENV"] || ENV["RUBY_ENV"] || ENV["ENV"]
        raise Errors.production_blocked if env == "production"
      end

      signature = req.headers["x-signature"] || req.headers["X-Signature"] || ""

      unless Hmac.verify_signature(req.body, signature, config.shared_secret)
        raise Errors.invalid_signature
      end

      begin
        body = JSON.parse(req.body)
      rescue JSON::ParserError
        raise Errors.invalid_body("invalid JSON")
      end

      action = body["action"]
      raise Errors.invalid_body("missing action") unless action

      case action
      when "discover"
        handle_discover(config)
      when "up"
        handle_up(config, body)
      when "down"
        handle_down(config, body)
      else
        raise Errors.unknown_action(action)
      end
    rescue AutonomaError => e
      HandlerResponse.new(status: e.status, body: { "error" => e.message, "code" => e.code })
    rescue StandardError => e
      HandlerResponse.new(status: 500, body: { "error" => e.message, "code" => "INTERNAL_ERROR" })
    end

    def self.get_introspection(config)
      cached = config.instance_variable_get(:@_introspection_cache)
      return cached if cached

      dialect = Dialect.get_dialect(config.dialect)
      result = Introspect.introspect_database(
        config.executor,
        dialect,
        scope_field: config.scope_field,
        schema: config.db_schema,
        table_name_map: config.table_name_map,
        exclude_tables: config.exclude_tables
      )
      config.instance_variable_set(:@_introspection_cache, result)
      result
    end

    def self.build_sdk_meta(config)
      sdk = config.sdk || {}
      {
        "version" => PROTOCOL_VERSION,
        "sdk" => {
          "language" => "ruby",
          "orm" => sdk["orm"] || sdk[:orm] || "unknown",
          "server" => sdk["server"] || sdk[:server] || "unknown"
        }
      }
    end

    def self.handle_discover(config)
      introspection = get_introspection(config)
      schema = introspection.schema

      schema_dict = {
        "models" => schema.models.map do |m|
          {
            "name" => m.name,
            "tableName" => m.table_name,
            "fields" => m.fields.map do |f|
              {
                "name" => f.name, "type" => f.type,
                "isRequired" => f.is_required, "isId" => f.is_id, "hasDefault" => f.has_default
              }
            end
          }
        end,
        "edges" => schema.edges.map do |e|
          {
            "from" => e.from_model, "to" => e.to_model,
            "localField" => e.local_field, "foreignField" => e.foreign_field,
            "nullable" => e.nullable
          }
        end,
        "relations" => schema.relations.map do |r|
          {
            "parentModel" => r.parent_model, "childModel" => r.child_model,
            "parentField" => r.parent_field, "childField" => r.child_field
          }
        end,
        "scopeField" => schema.scope_field
      }

      HandlerResponse.new(status: 200, body: build_sdk_meta(config).merge("schema" => schema_dict))
    end

    def self.handle_up(config, body)
      create = body["create"]
      raise Errors.invalid_body('missing "create" in request body') unless create

      test_run_id = body["testRunId"] || SecureRandom.uuid
      introspection = get_introspection(config)
      schema = introspection.schema
      dialect = Dialect.get_dialect(config.dialect)

      tree = Tree.resolve_tree(create, schema)
      refs = {}
      id_map = {}

      config.executor.transaction do |tx|
        i = 0
        while i < tree.ops.length
          op = tree.ops[i]
          model = op.model

          # Collect consecutive ops for the same model with same batch flag
          batch = [op]
          while i + 1 < tree.ops.length && tree.ops[i + 1].model == model && tree.ops[i + 1].batch == op.batch
            i += 1
            batch << tree.ops[i]
          end

          # Find model info for auto-populating fields and dynamic PK
          model_info = schema.models.find { |m| m.name == model }
          pk_field = model_info&.fields&.find { |f| f.is_id }
          pk_field_name = pk_field&.name || "id"

          resolved_fields = batch.map do |b|
            fields = b.fields.dup

            # Replace temp IDs with real IDs
            fields.each do |key, value|
              if value.is_a?(String) && value.start_with?("__temp_")
                real_id = id_map[value]
                fields[key] = real_id if real_id
              end
            end

            # Inject scope field if applicable
            scope_edge = schema.edges.find do |e|
              e.from_model == model && e.local_field.downcase == schema.scope_field.downcase && e.from_model != e.to_model
            end
            if scope_edge && !fields.key?(scope_edge.local_field)
              scope_val = detect_scope_value(refs, schema.scope_field)
              fields[scope_edge.local_field] = scope_val if scope_val
            end

            # Auto-populate required DateTime fields without defaults
            if model_info
              model_info.fields.each do |field|
                if field.is_required && !field.has_default && !field.is_id && !fields.key?(field.name)
                  fields[field.name] = Time.now.utc if field.type == "DateTime"
                end
              end
            end

            fields
          end

          spec = { model => { "count" => resolved_fields.length, "fields" => resolved_fields, "batch" => op.batch } }
          created = Create.create_entities(tx, dialect, introspection.table_map, introspection.column_maps, spec, introspection.enum_type_maps, schema.models)
          records = created[model] || []

          refs[model] = (refs[model] || []) + records

          batch.each_with_index do |b, j|
            next unless j < records.length

            record = records[j]
            record_id = record[pk_field_name]
            id_map[b.temp_id] = record_id unless record_id.nil?
          end

          i += 1
        end

        # Resolve deferred FK updates
        tree.deferred_updates.each do |deferred|
          real_target_id = id_map[deferred.target_temp_id]
          ref_temp_id = tree.aliases[deferred.ref_alias]
          real_ref_id = ref_temp_id ? id_map[ref_temp_id] : nil

          unless real_target_id && real_ref_id
            raise "_ref \"#{deferred.ref_alias}\" could not be resolved. " \
                  "Ensure the referenced node has _alias defined in the scenario."
          end

          deferred_model_info = schema.models.find { |m| m.name == deferred.model }
          deferred_pk_field_name = deferred_model_info&.fields&.find { |f| f.is_id }&.name || "id"
          Create.update_entity(
            tx, dialect, introspection.table_map, introspection.column_maps,
            deferred.model, real_target_id, { deferred.field => real_ref_id },
            introspection.enum_type_maps, deferred_pk_field_name
          )
        end
      end

      scope_value = detect_scope_value(refs, schema.scope_field) || test_run_id

      first_user = find_first_user(refs)
      auth = config.auth.call(first_user)

      refs_token = Refs.sign_refs(
        { "refs" => refs, "testRunId" => scope_value, "environment" => "" },
        config.signing_secret
      )

      HandlerResponse.new(
        status: 200,
        body: build_sdk_meta(config).merge("auth" => auth, "refs" => refs, "refsToken" => refs_token)
      )
    end

    def self.handle_down(config, body)
      refs_token = body["refsToken"]
      raise Errors.invalid_body("missing refsToken") unless refs_token

      begin
        payload = Refs.verify_refs(refs_token, config.signing_secret)
      rescue StandardError => e
        raise Errors.invalid_refs_token(e.message)
      end

      introspection = get_introspection(config)
      dialect = Dialect.get_dialect(config.dialect)

      Teardown.teardown(
        config.executor, dialect,
        introspection.table_map, introspection.column_maps,
        introspection.schema, payload["testRunId"], payload["refs"]
      )

      HandlerResponse.new(status: 200, body: build_sdk_meta(config).merge("ok" => true))
    end

    def self.find_first_user(refs)
      refs.each do |model, records|
        normalized = model.downcase
        return records.first if (normalized == "user" || normalized == "users") && records.any?
      end
      nil
    end

    def self.detect_scope_value(refs, scope_field)
      scope_lower = scope_field.downcase
      refs.each_value do |records|
        records.each do |record|
          record.each do |key, value|
            return value if key.downcase == scope_lower && value.is_a?(String)
          end
        end
      end
      nil
    end

    private_class_method :get_introspection, :build_sdk_meta, :handle_discover, :handle_up,
                         :handle_down, :find_first_user, :detect_scope_value
  end
end
