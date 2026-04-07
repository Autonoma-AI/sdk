# frozen_string_literal: true

require "set"
require_relative "types"
require_relative "dialect"

module Autonoma
  module Introspect
    def self.introspect_database(executor, dialect, scope_field:, schema: nil, table_name_map: nil, exclude_tables: nil)
      db_schema = schema || (dialect.name != "mysql" ? "public" : nil)
      raise ArgumentError, "MySQL requires a schema (database name). Pass it via db_schema or HandlerConfig.db_schema." unless db_schema

      exclude_set = (exclude_tables || ["_prisma_migrations"]).to_set

      # Run all introspection queries
      table_rows = executor.query(dialect.tables_sql(db_schema))
      column_rows = executor.query(dialect.columns_sql(db_schema))
      pk_rows = executor.query(dialect.primary_keys_sql(db_schema))
      fk_rows = executor.query(dialect.foreign_keys_sql(db_schema))
      enum_rows = executor.query(dialect.enums_sql(db_schema))

      # Normalize keys to lowercase
      table_rows = normalize_keys(table_rows)
      column_rows = normalize_keys(column_rows)
      pk_rows = normalize_keys(pk_rows)
      fk_rows = normalize_keys(fk_rows)
      enum_rows = normalize_keys(enum_rows)

      # Build enum lookup
      enum_values = {}
      enum_rows.each do |row|
        name = row["enum_name"]
        next unless name

        (enum_values[name] ||= []) << row["enum_value"]
      end

      # MySQL: parse inline enums from column_type
      if dialect.name == "mysql"
        column_rows.each do |col|
          parsed = parse_mysql_enum(col["udt_name"] || "")
          if parsed
            key = "#{col['table_name']}.#{col['column_name']}"
            enum_values[key] = parsed
          end
        end
      end

      # Build PK lookup
      pks_by_table = {}
      pk_rows.each do |row|
        (pks_by_table[row["table_name"]] ||= Set.new) << row["column_name"]
      end

      # Build table name mapping
      user_map = table_name_map || {}
      t_map = {}
      reverse_table_map = {}

      user_map.each do |model, db_table|
        t_map[model] = db_table
        reverse_table_map[db_table] = model
      end

      db_tables = table_rows.filter_map { |r| r["table_name"] unless exclude_set.include?(r["table_name"]) }
      db_tables.each do |db_table|
        next if reverse_table_map.key?(db_table)

        model_name = snake_to_pascal(db_table)
        t_map[model_name] = db_table
        reverse_table_map[db_table] = model_name
      end

      # Group columns by table
      columns_by_table = {}
      column_rows.each do |row|
        (columns_by_table[row["table_name"]] ||= []) << row
      end

      # Build models and column maps
      models = []
      column_maps = {}
      enum_type_maps = {}

      t_map.each do |model_name, db_table|
        cols = columns_by_table[db_table] || []
        pks = pks_by_table[db_table] || Set.new
        col_map = {}
        fields = []

        cols.each do |col|
          field_name = snake_to_camel(col["column_name"])
          col_map[field_name] = col["column_name"]

          # Check for enums
          enum_vals = if dialect.name == "mysql"
                        enum_values["#{col['table_name']}.#{col['column_name']}"]
                      else
                        enum_values[col["udt_name"] || ""]
                      end

          field_type = if enum_vals
                         "enum(#{enum_vals.join(',')})"
                       else
                         map_data_type(col["data_type"], col["udt_name"] || "", dialect.name)
                       end

          # Track Postgres types needing casts
          if dialect.name == "postgres"
            if enum_vals
              (enum_type_maps[model_name] ||= {})[field_name] = col["udt_name"] || ""
            elsif ["jsonb", "json"].include?(col["data_type"]) || ["jsonb", "json"].include?(col["udt_name"] || "")
              json_type = (col["data_type"] == "json" || col["udt_name"] == "json") ? "json" : "jsonb"
              (enum_type_maps[model_name] ||= {})[field_name] = json_type
            elsif col["data_type"]&.include?("timestamp") || ["timestamptz", "timestamp"].include?(col["udt_name"] || "")
              (enum_type_maps[model_name] ||= {})[field_name] = col["udt_name"] || ""
            end
          end

          fields << FieldInfo.new(
            name: field_name,
            type: field_type,
            is_required: col["is_nullable"] == "NO",
            is_id: pks.include?(col["column_name"]),
            has_default: !col["column_default"].nil?
          )
        end

        column_maps[model_name] = col_map
        models << ModelInfo.new(name: model_name, fields: fields)
      end

      # Build FK edges
      edges = []
      fk_rows.each do |fk|
        from_model = reverse_table_map[fk["from_table"]]
        to_model = reverse_table_map[fk["to_table"]]
        next unless from_model && to_model

        from_col_map = column_maps[from_model] || {}
        to_col_map = column_maps[to_model] || {}
        local_field = reverse_get(from_col_map, fk["from_column"]) || fk["from_column"]
        foreign_field = reverse_get(to_col_map, fk["to_column"]) || fk["to_column"]

        edges << FKEdge.new(
          from_model: from_model,
          to_model: to_model,
          local_field: local_field,
          foreign_field: foreign_field,
          nullable: fk["is_nullable"] == "YES"
        )
      end

      # Build relations from FK edges
      relations = []
      edges.each do |edge|
        from_db_table = t_map[edge.from_model] || ""
        from_col_map = column_maps[edge.from_model] || {}
        fk_db_col = from_col_map[edge.local_field] || edge.local_field
        from_pks = pks_by_table[from_db_table] || Set.new
        is_one_to_one = from_pks.size == 1 && from_pks.include?(fk_db_col)

        # Parent-side
        relations << SchemaRelation.new(
          parent_model: edge.to_model,
          child_model: edge.from_model,
          parent_field: is_one_to_one ? lower_first(edge.from_model) : plural_camel_case(edge.from_model),
          child_field: edge.local_field
        )

        # Child-side
        relations << SchemaRelation.new(
          parent_model: edge.from_model,
          child_model: edge.to_model,
          parent_field: lower_first(edge.to_model),
          child_field: edge.local_field
        )
      end

      schema_info = SchemaInfo.new(models: models, edges: edges, relations: relations, scope_field: scope_field)
      IntrospectionResult.new(
        schema: schema_info,
        table_map: t_map,
        column_maps: column_maps,
        enum_type_maps: enum_type_maps
      )
    end

    # --- Name mapping utilities ---

    def self.snake_to_pascal(s)
      s.split("_").reject(&:empty?).map { |part| part[0].upcase + part[1..] }.join
    end

    def self.snake_to_camel(s)
      pascal = snake_to_pascal(s)
      return "" if pascal.empty?

      pascal[0].downcase + pascal[1..]
    end

    def self.lower_first(s)
      return "" if s.nil? || s.empty?

      s[0].downcase + s[1..]
    end

    def self.plural_camel_case(model_name)
      camel = lower_first(model_name)
      pluralize(camel)
    end

    def self.pluralize(s)
      if s.end_with?("s", "x", "z", "ch", "sh")
        "#{s}es"
      elsif s.end_with?("y") && s.length > 1 && !"aeiou".include?(s[-2])
        "#{s[0..-2]}ies"
      else
        "#{s}s"
      end
    end

    def self.parse_mysql_enum(column_type)
      return nil if column_type.nil? || column_type.empty?

      m = column_type.match(/\Aenum\((.+)\)\z/i)
      return nil unless m

      m[1].split(",").map { |v| v.strip.gsub(/\A'|'\z/, "") }
    end

    def self.map_data_type(data_type, udt_name, dialect_name)
      dt = data_type.downcase
      case dt
      when "integer", "smallint", "bigint", "int", "mediumint", "tinyint"
        "Int"
      when "numeric", "real", "double precision", "float", "double", "decimal"
        "Float"
      when "boolean"
        "Boolean"
      when "tinyint(1)"
        "Boolean"
      when "text", "character varying", "character", "varchar", "char", "mediumtext", "longtext", "tinytext"
        "String"
      when "timestamp with time zone", "timestamp without time zone", "date", "time", "datetime", "timestamp"
        "DateTime"
      when "json", "jsonb"
        "Json"
      when "uuid"
        "String"
      when "bytea", "blob", "mediumblob", "longblob", "tinyblob", "binary", "varbinary"
        "Bytes"
      when "user-defined"
        dialect_name == "postgres" ? udt_name : data_type
      when "enum", "set"
        udt_name
      else
        data_type
      end
    end

    def self.normalize_keys(rows)
      rows.map { |row| row.transform_keys(&:downcase) }
    end

    def self.reverse_get(mapping, db_name)
      mapping.each { |key, val| return key if val == db_name }
      nil
    end

    private_class_method :normalize_keys, :reverse_get, :parse_mysql_enum, :map_data_type,
                         :snake_to_pascal, :snake_to_camel, :lower_first, :plural_camel_case, :pluralize
  end
end
