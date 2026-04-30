# frozen_string_literal: true

module Autonoma
  module Schema
    VALID_TYPES = Set.new(%w[string integer number boolean timestamp date uuid json]).freeze

    # Map a Ruby type string to the SDK's coarse type string.
    def self.field_type_from_class(type_str)
      return "string" if type_str.nil?

      normalized = type_str.to_s.downcase
      VALID_TYPES.include?(normalized) ? normalized : "string"
    end

    # Convert CamelCase to snake_case for cosmetic tableName.
    def self.camel_to_snake(name)
      out = []
      name.each_char.with_index do |ch, i|
        if ch =~ /[A-Z]/ && i > 0 && name[i - 1] !~ /[A-Z]/
          out << "_"
        end
        out << ch.downcase
      end
      out.join
    end

    # Build field list from input_fields array.
    # Each entry is a hash with :name, :type, :required keys.
    def self.fields_from_input_fields(input_fields)
      fields = [
        FieldInfo.new(
          name: "id",
          type: "string",
          is_required: false,
          is_id: true,
          has_default: true
        )
      ]

      (input_fields || []).each do |f|
        name = f[:name] || f["name"]
        type = f[:type] || f["type"]
        required = f[:required].nil? ? f["required"] : f[:required]

        fields << FieldInfo.new(
          name: name.to_s,
          type: field_type_from_class(type),
          is_required: !!required,
          is_id: false,
          has_default: !required
        )
      end

      fields
    end

    # Build the SDK's discover-time schema from registered factories.
    def self.build_schema_from_factories(factories, scope_field)
      models = []

      (factories || {}).each do |entity, factory|
        if factory.input_fields.nil? || factory.input_fields.empty?
          raise ArgumentError,
                "Factory \"#{entity}\" has no input_fields. " \
                "Every factory must declare input_fields in define_factory(...)."
        end

        models << ModelInfo.new(
          name: entity,
          table_name: camel_to_snake(entity),
          fields: fields_from_input_fields(factory.input_fields)
        )
      end

      SchemaInfo.new(
        models: models,
        edges: [],
        relations: [],
        scope_field: scope_field
      )
    end

    # Serialise a SchemaInfo to the JSON shape the dashboard expects.
    def self.schema_to_wire(schema)
      {
        "models" => schema.models.map do |m|
          {
            "name" => m.name,
            "tableName" => m.table_name,
            "fields" => m.fields.map do |f|
              {
                "name" => f.name,
                "type" => f.type,
                "isRequired" => f.is_required,
                "isId" => f.is_id,
                "hasDefault" => f.has_default
              }
            end
          }
        end,
        "edges" => schema.edges.map do |e|
          {
            "from" => e.from_model,
            "to" => e.to_model,
            "localField" => e.local_field,
            "foreignField" => e.foreign_field,
            "nullable" => e.nullable
          }
        end,
        "relations" => schema.relations.map do |r|
          {
            "parentModel" => r.parent_model,
            "childModel" => r.child_model,
            "parentField" => r.parent_field,
            "childField" => r.child_field
          }
        end,
        "scopeField" => schema.scope_field
      }
    end

    # Validate input fields hash: strip unknown keys, check required fields.
    def self.validate_input(fields, input_fields)
      known_names = Set.new
      required_names = []

      (input_fields || []).each do |f|
        name = (f[:name] || f["name"]).to_s
        known_names.add(name)
        req = f[:required].nil? ? f["required"] : f[:required]
        required_names << name if req
      end

      # Strip unknown keys
      validated = fields.select { |k, _| known_names.include?(k.to_s) }

      # Check required fields
      missing = required_names.select { |name| !validated.key?(name) && !validated.key?(name.to_sym) }
      unless missing.empty?
        raise Errors.invalid_body("missing required fields: #{missing.join(", ")}")
      end

      validated
    end

    private_class_method :camel_to_snake, :fields_from_input_fields
  end
end
