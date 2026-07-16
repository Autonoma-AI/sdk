# frozen_string_literal: true

require "json"
require "securerandom"
require "set"

require_relative "hmac"
require_relative "refs"
require_relative "errors"
require_relative "types"
require_relative "payload_topo"
require_relative "schema"

module Autonoma
  module Handler
    PROTOCOL_VERSION = begin
      File.read(File.expand_path("../../../../protocol/version.txt", __dir__)).strip
    rescue Errno::ENOENT, Errno::EACCES
      "1.0"
    end

    TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/
    CYCLE_RE = /\Acycle\((.*)\)\z/

    def self.handle_request(config, req)
      if config.shared_secret == config.signing_secret
        raise Errors.same_secrets
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

    # -----------------------------------------------------------------------
    # discover
    # -----------------------------------------------------------------------

    def self.handle_discover(config)
      schema = Schema.build_schema_from_factories(config.factories || {}, config.scope_field)
      HandlerResponse.new(
        status: 200,
        body: build_sdk_meta(config).merge("schema" => Schema.schema_to_wire(schema))
      )
    end

    # -----------------------------------------------------------------------
    # up
    # -----------------------------------------------------------------------

    def self.handle_up(config, body)
      create = body["create"]
      raise Errors.invalid_body('missing "create" in request body') unless create

      test_run_id = body["testRunId"] || SecureRandom.uuid

      factories = config.factories || {}
      if factories.empty?
        raise Errors.invalid_body(
          "no factories registered -- every model in `create` must have a factory."
        )
      end

      tree = PayloadTopo.resolve_payload_tree(create)

      refs = {}
      id_map = {}

      # Track per-model run index for {{index}} / {{cycle()}} substitution.
      model_index = Hash.new(0)

      tree.ops.each do |op|
        model = op.model
        factory = factories[model]
        if factory.nil?
          raise Errors.invalid_body(
            "no factory registered for model \"#{model}\". " \
            "Register one with define_factory(...) and add it to HandlerConfig factories."
          )
        end

        idx = model_index[model]
        model_index[model] = idx + 1

        # Substitute built-in tokens then swap temp ids for real ids.
        resolved = resolve_tokens(op.fields, test_run_id, idx)
        resolved = swap_temp_ids(resolved, id_map)

        # Validate through the factory's input_fields.
        validated = Schema.validate_input(resolved, factory.input_fields)

        ctx = FactoryContext.new(
          refs: refs,
          scenario_name: test_run_id,
          test_run_id: test_run_id
        )

        record = factory.create.call(validated, ctx)

        # Normalise to hash if needed.
        if record.respond_to?(:to_h) && !record.is_a?(Hash)
          record = record.to_h
        end

        if !record.is_a?(Hash) || record["id"].nil?
          raise AutonomaError.new(
            "Factory for \"#{model}\" must return a record hash with \"id\"",
            "FACTORY_MISSING_PK",
            500
          )
        end

        refs[model] = (refs[model] || []) + [record]
        id_map[op.temp_id] = record["id"]
      end

      # Auth callback gets the first User (case-insensitive on model name).
      auth_user = find_first_user(refs)
      scope_value = detect_scope_value(refs, config.scope_field) || test_run_id
      auth_context = AuthContext.new(scope_value: scope_value, refs: refs)
      auth = config.auth.call(auth_user, auth_context)

      if config.after_up
        hook_ctx = HookContext.new(scenario_name: scope_value, refs: refs)
        auth = config.after_up.call(hook_ctx, auth)
      end

      refs_token = Refs.sign_refs(
        {
          "refs" => refs,
          "testRunId" => scope_value,
          "environment" => "",
          "aliasDependencies" => tree.alias_dependencies,
          "aliasOwnerModel" => tree.alias_owner_model
        },
        config.signing_secret
      )

      HandlerResponse.new(
        status: 200,
        body: build_sdk_meta(config).merge(
          "auth" => auth,
          "refs" => refs,
          "refsToken" => refs_token
        )
      )
    end

    # -----------------------------------------------------------------------
    # down
    # -----------------------------------------------------------------------

    def self.handle_down(config, body)
      refs_token = body["refsToken"]
      raise Errors.invalid_body("missing refsToken") unless refs_token

      begin
        payload = Refs.verify_refs(refs_token, config.signing_secret)
      rescue StandardError => e
        raise Errors.invalid_refs_token(e.message)
      end

      refs = payload["refs"] || {}
      test_run_id = payload["testRunId"] || ""
      alias_deps = payload["aliasDependencies"] || {}
      alias_owner_model = payload["aliasOwnerModel"] || {}

      if config.before_down
        hook_ctx = HookContext.new(scenario_name: test_run_id, refs: refs)
        config.before_down.call(hook_ctx)
      end

      factories = config.factories || {}
      teardown_order = PayloadTopo.compute_teardown_order(refs, alias_deps, alias_owner_model)

      teardown_order.each do |model|
        factory = factories[model]
        next if factory.nil? || factory.teardown.nil?

        records = refs[model] || []
        ctx = FactoryContext.new(
          refs: refs,
          scenario_name: test_run_id,
          test_run_id: test_run_id
        )

        records.reverse_each do |record|
          factory.teardown.call(record, ctx)
        end
      end

      HandlerResponse.new(status: 200, body: build_sdk_meta(config).merge("ok" => true))
    end

    # -----------------------------------------------------------------------
    # helpers
    # -----------------------------------------------------------------------

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

    # Substitute built-in tokens in field values: {{testRunId}}, {{index}},
    # {{cycle(a,b,c)}}. Raises AutonomaError(UNRESOLVED_TOKEN) for any other
    # {{token}}.
    def self.resolve_tokens(value, test_run_id, index)
      case value
      when String
        value.gsub(TOKEN_RE) do
          token = Regexp.last_match(1).strip
          if token == "testRunId"
            test_run_id
          elsif token == "index"
            index.to_s
          elsif (m = CYCLE_RE.match(token))
            parts = m[1].split(",").map { |p| p.strip.gsub(/\A['"]|['"]\z/, "") }
            parts.empty? ? "" : parts[index % parts.length]
          else
            raise AutonomaError.new(
              "Unresolved token: {{#{token}}}",
              "UNRESOLVED_TOKEN",
              400
            )
          end
        end
      when Array
        value.map { |v| resolve_tokens(v, test_run_id, index) }
      when Hash
        value.each_with_object({}) { |(k, v), out| out[k] = resolve_tokens(v, test_run_id, index) }
      else
        value
      end
    end

    # Replace any __temp_* placeholder string with its real id.
    def self.swap_temp_ids(value, id_map)
      case value
      when String
        value.start_with?("__temp_") ? (id_map[value] || value) : value
      when Hash
        value.each_with_object({}) { |(k, v), out| out[k] = swap_temp_ids(v, id_map) }
      when Array
        value.map { |v| swap_temp_ids(v, id_map) }
      else
        value
      end
    end

    def self.find_first_user(refs)
      refs.each do |model, records|
        normalized = model.downcase
        return records.first if (normalized == "user" || normalized == "users") && records.any?
      end
      nil
    end

    def self.detect_scope_value(refs, scope_field)
      scope_normalized = scope_field.delete("_").downcase
      refs.each_value do |records|
        records.each do |record|
          record.each do |key, value|
            return value if key.delete("_").downcase == scope_normalized && value.is_a?(String)
          end
        end
      end
      nil
    end

    private_class_method :build_sdk_meta, :handle_discover, :handle_up,
                         :handle_down, :find_first_user, :detect_scope_value,
                         :resolve_tokens, :swap_temp_ids
  end
end
