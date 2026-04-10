# frozen_string_literal: true

require "securerandom"
require "json"
require "time"

module Autonoma
  module Create
    MYSQL_DATETIME_RE = /\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/

    # Create entities from a resolved spec. Spec maps model name -> {count, fields[], batch}.
    def self.create_entities(executor, dialect, table_map, column_maps, spec, enum_type_maps = {}, schema_models = [])
      enum_type_maps ||= {}
      results = {}

      spec.each do |model, entity_spec|
        db_table = table_map[model]
        raise "Unknown model \"#{model}\". Not found in database tables." unless db_table

        col_map = column_maps[model] || {}
        enum_type_map = enum_type_maps[model] || {}

        # Bug 4: find actual PK field name from schema
        # When multiple is_id fields exist (composite PK), prefer the one named "id"
        model_info = schema_models.find { |m| m.name == model }
        id_fields = model_info&.fields&.select { |f| f.is_id } || []
        pk_field = id_fields.find { |f| f.name.downcase == "id" } || id_fields.first
        pk_field_name = pk_field&.name || "id"
        pk_field_type = pk_field&.type || "String"

        fields_list = entity_spec["fields"] || entity_spec[:fields] || []
        is_batch = entity_spec["batch"] || entity_spec[:batch] || false

        results[model] = if is_batch && fields_list.any?
                           insert_batch(executor, dialect, db_table, col_map, enum_type_map, fields_list, pk_field_name, pk_field_type)
                         else
                           fields_list.map do |fields|
                             rows = insert_one(executor, dialect, db_table, col_map, enum_type_map, fields, pk_field_name, pk_field_type)
                             rows.first
                           end.compact
                         end
      end

      results
    end

    # Update a single record by primary key. Used for circular FK backfill.
    def self.update_entity(executor, dialect, table_map, column_maps, model, record_id, fields, enum_type_maps = nil, pk_field_name = "id")
      db_table = table_map[model]
      raise "Unknown model \"#{model}\" for update." unless db_table

      col_map = column_maps[model] || {}
      enum_type_map = (enum_type_maps || {})[model] || {}

      set_clauses = []
      params = []
      param_idx = 1

      fields.each do |field_name, value|
        db_col = col_map[field_name] || field_name
        set_clauses << "#{dialect.quote_id(db_col)} = #{cast_param(dialect, param_idx, enum_type_map, field_name)}"
        params << serialize_value(value, dialect)
        param_idx += 1
      end

      id_col = col_map[pk_field_name] || pk_field_name
      params << record_id

      sql = "UPDATE #{dialect.quote_id(db_table)} SET #{set_clauses.join(', ')} WHERE #{dialect.quote_id(id_col)} = #{dialect.param(param_idx)}"
      executor.query(sql, params)
    end

    # --- Internal helpers ---

    def self.insert_one(executor, dialect, db_table, col_map, enum_type_map, fields, pk_field_name = "id", pk_field_type = "String")
      # Generate client-side UUID only when PK type is String.
      # Int/BigInt PKs use DB auto-increment, so we skip UUID generation for those.
      if pk_field_name && !fields.key?(pk_field_name) && pk_field_type == "String"
        fields = fields.merge(pk_field_name => SecureRandom.uuid)
      end

      entries = fields.to_a
      if entries.empty?
        if dialect.supports_returning
          sql = "INSERT INTO #{dialect.quote_id(db_table)} DEFAULT VALUES RETURNING *"
          return map_rows_back(executor.query(sql), col_map)
        end

        executor.query("INSERT INTO #{dialect.quote_id(db_table)} () VALUES ()")
        id_col = col_map[pk_field_name] || pk_field_name
        record_id = fields[pk_field_name]
        raise "Cannot fetch inserted row without RETURNING support and a known id" if record_id.nil?

        return map_rows_back(
          executor.query(
            "SELECT * FROM #{dialect.quote_id(db_table)} WHERE #{dialect.quote_id(id_col)} = #{dialect.param(1)}",
            [record_id]
          ),
          col_map
        )
      end

      db_cols = []
      params = []
      placeholders = []
      param_idx = 1

      entries.each do |field_name, value|
        db_col = col_map[field_name] || field_name
        db_cols << dialect.quote_id(db_col)
        placeholders << cast_param(dialect, param_idx, enum_type_map, field_name)
        params << serialize_value(value, dialect)
        param_idx += 1
      end

      col_list = db_cols.join(", ")
      val_list = placeholders.join(", ")

      if dialect.supports_returning
        sql = "INSERT INTO #{dialect.quote_id(db_table)} (#{col_list}) VALUES (#{val_list}) RETURNING *"
        return map_rows_back(executor.query(sql, params), col_map)
      end

      # MySQL: INSERT then SELECT back
      executor.query(
        "INSERT INTO #{dialect.quote_id(db_table)} (#{col_list}) VALUES (#{val_list})",
        params
      )
      id_col = col_map[pk_field_name] || pk_field_name
      record_id = fields[pk_field_name]
      map_rows_back(
        executor.query(
          "SELECT * FROM #{dialect.quote_id(db_table)} WHERE #{dialect.quote_id(id_col)} = #{dialect.param(1)}",
          [record_id]
        ),
        col_map
      )
    end

    def self.insert_batch(executor, dialect, db_table, col_map, enum_type_map, fields_arr, pk_field_name = "id", pk_field_type = "String")
      return [] if fields_arr.empty?

      # Generate client-side IDs only when PK type is String.
      # Int/BigInt PKs use DB auto-increment.
      if pk_field_name && pk_field_type == "String"
        fields_arr = fields_arr.map do |f|
          f.key?(pk_field_name) ? f : f.merge(pk_field_name => SecureRandom.uuid)
        end
      end

      # Compute the union of keys across all rows in deterministic (sorted) order.
      # Rows missing a key will use NULL.
      field_names = fields_arr.each_with_object({}) { |f, set| f.each_key { |k| set[k] = true } }.keys.sort

      # If no fields at all, fall back to individual inserts
      if field_names.empty?
        return fields_arr.map do |fields|
          rows = insert_one(executor, dialect, db_table, col_map, enum_type_map, fields)
          rows.first
        end.compact
      end

      db_cols_list = field_names.map { |f| dialect.quote_id(col_map[f] || f) }
      col_list = db_cols_list.join(", ")

      # Chunk to stay within bind variable limits (Postgres 32,767)
      max_params = 32_000
      chunk_size = [1, max_params / field_names.length].max
      all_results = []

      fields_arr.each_slice(chunk_size) do |chunk|
        params = []
        value_tuples = []
        param_idx = 1

        chunk.each do |fields|
          phs = field_names.map do |fn|
            ph = cast_param(dialect, param_idx, enum_type_map, fn)
            params << serialize_value(fields[fn], dialect)
            param_idx += 1
            ph
          end
          value_tuples << "(#{phs.join(', ')})"
        end

        val_list = value_tuples.join(", ")

        if dialect.supports_returning
          sql = "INSERT INTO #{dialect.quote_id(db_table)} (#{col_list}) VALUES #{val_list} RETURNING *"
          all_results.concat(map_rows_back(executor.query(sql, params), col_map))
        else
          executor.query(
            "INSERT INTO #{dialect.quote_id(db_table)} (#{col_list}) VALUES #{val_list}",
            params
          )
          # Select back inserted rows by client-generated IDs
          if pk_field_name
            ids = chunk.map { |f| f[pk_field_name] }.compact
            if ids.any?
              id_col = col_map[pk_field_name] || pk_field_name
              placeholders = ids.each_with_index.map { |_, i| dialect.param(i + 1) }.join(", ")
              all_results.concat(
                map_rows_back(
                  executor.query(
                    "SELECT * FROM #{dialect.quote_id(db_table)} WHERE #{dialect.quote_id(id_col)} IN (#{placeholders})",
                    ids
                  ),
                  col_map
                )
              )
            end
          end
        end
      end

      all_results
    end

    def self.map_rows_back(rows, col_map)
      return rows if col_map.empty?

      reverse = col_map.invert
      rows.map { |row| row.transform_keys { |k| reverse[k] || k } }
    end

    def self.cast_param(dialect, param_idx, enum_type_map, field_name)
      placeholder = dialect.param(param_idx)
      if dialect.name == "postgres"
        enum_type = enum_type_map[field_name]
        return "#{placeholder}::#{dialect.quote_id(enum_type)}" if enum_type
      end
      placeholder
    end

    def self.serialize_value(value, dialect)
      return value if value.nil?

      # JSON: stringify hashes (objects) for JSON/JSONB columns.
      # Arrays are returned as-is for Postgres ARRAY columns.
      return value if value.is_a?(Array)
      return JSON.generate(value) if value.is_a?(Hash)

      # Time objects
      if value.is_a?(Time)
        return value.strftime("%Y-%m-%d %H:%M:%S") if dialect.name == "mysql"

        return value.iso8601(3)
      end

      if value.is_a?(Date)
        return value.iso8601
      end

      # MySQL: convert ISO 8601 datetime strings
      if value.is_a?(String) && dialect.name == "mysql"
        if value.match?(MYSQL_DATETIME_RE)
          return value.gsub("T", " ").gsub("Z", "").gsub(/0+\z/, "").gsub(/\.\z/, "")
        end
      end

      value
    end

    private_class_method :insert_one, :insert_batch, :map_rows_back,
                         :cast_param, :serialize_value
  end
end
