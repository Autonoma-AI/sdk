# frozen_string_literal: true

module Autonoma
  FieldInfo = Struct.new(:name, :type, :is_required, :is_id, :has_default, keyword_init: true)
  ModelInfo = Struct.new(:name, :table_name, :fields, keyword_init: true)

  FKEdge = Struct.new(:from_model, :to_model, :local_field, :foreign_field, :nullable, keyword_init: true)

  SchemaRelation = Struct.new(:parent_model, :child_model, :parent_field, :child_field, keyword_init: true)

  SchemaInfo = Struct.new(:models, :edges, :relations, :scope_field, keyword_init: true)

  CreateOp = Struct.new(:model, :fields, :temp_id, keyword_init: true)

  HandlerRequest = Struct.new(:body, :headers, keyword_init: true) do
    def initialize(body:, headers: {})
      super
    end
  end

  HandlerResponse = Struct.new(:status, :body, keyword_init: true)

  HookContext = Struct.new(:scenario_name, :refs, keyword_init: true)
  AuthContext = Struct.new(:scope_value, :refs, keyword_init: true)

  FactoryContext = Struct.new(:refs, :scenario_name, :test_run_id, keyword_init: true)

  FactoryDefinition = Struct.new(:create, :teardown, :input_fields, keyword_init: true)

  HandlerConfig = Struct.new(
    :scope_field,
    :shared_secret,
    :signing_secret,
    # Deprecated - ignored; the endpoint is always enabled and HMAC signing is
    # the gate. On Autonoma previews (AUTONOMA_PREVIEWKIT set) no guard is
    # needed; gate manually in your handler for your own production deployments.
    :allow_production,
    :auth,
    :sdk,
    :before_down,
    :after_up,
    :factories,
    keyword_init: true
  ) do
    def initialize(scope_field:, shared_secret:, signing_secret:, auth:,
                   allow_production: false, sdk: nil,
                   before_down: nil, after_up: nil, factories: nil)
      if allow_production
        warn "[autonoma] allow_production is deprecated and ignored - the endpoint is always enabled"
      end
      super
    end
  end
end
