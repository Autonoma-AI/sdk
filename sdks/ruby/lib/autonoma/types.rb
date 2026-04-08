# frozen_string_literal: true

module Autonoma
  FieldInfo = Struct.new(:name, :type, :is_required, :is_id, :has_default, keyword_init: true)
  ModelInfo = Struct.new(:name, :table_name, :fields, keyword_init: true)

  FKEdge = Struct.new(:from_model, :to_model, :local_field, :foreign_field, :nullable, keyword_init: true)

  SchemaRelation = Struct.new(:parent_model, :child_model, :parent_field, :child_field, keyword_init: true)

  SchemaInfo = Struct.new(:models, :edges, :relations, :scope_field, keyword_init: true)

  IntrospectionResult = Struct.new(:schema, :table_map, :column_maps, :enum_type_maps, keyword_init: true)

  CreateOp = Struct.new(:model, :fields, :temp_id, :batch, keyword_init: true)

  DeferredUpdate = Struct.new(:target_temp_id, :model, :field, :ref_alias, keyword_init: true)

  HandlerRequest = Struct.new(:body, :headers, keyword_init: true) do
    def initialize(body:, headers: {})
      super
    end
  end

  HandlerResponse = Struct.new(:status, :body, keyword_init: true)

  HandlerConfig = Struct.new(
    :executor,
    :scope_field,
    :shared_secret,
    :signing_secret,
    :dialect,
    :db_schema,
    :table_name_map,
    :exclude_tables,
    :allow_production,
    :auth,
    :sdk,
    keyword_init: true
  ) do
    def initialize(executor:, scope_field:, shared_secret:, signing_secret:, auth:,
                   dialect: "postgres", db_schema: nil, table_name_map: nil,
                   exclude_tables: nil, allow_production: false, sdk: nil)
      super
    end
  end

  # SQL executor interface — duck-typed in Ruby.
  # Classes implementing this must respond to:
  #   #query(sql, params = []) -> Array<Hash>
  #   #transaction { |tx| ... } -> result
  module SQLExecutor
    def query(sql, params = [])
      raise NotImplementedError
    end

    def transaction(&block)
      raise NotImplementedError
    end
  end
end
