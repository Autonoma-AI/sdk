# frozen_string_literal: true

require "securerandom"
require "json"
require "time"

module Autonoma
  module Create
    # Create entities from a resolved spec. Spec maps model name -> {count, fields[], batch}.
    def self.create_entities(executor, dialect, table_map, column_maps, spec, enum_type_maps = {})
      enum_type_maps ||= {}
      results = {}

      spec.each do |model, entity_spec|
        db_table = table_map[model]
        raise "Unknown model \"#{model}\". Not found in database tables." unless db_table

        col_map = column_maps[model] || {}
        enum_type_map = enum_type_maps[model] || {}

        fields_list = entity_spec["fields"] || entity_spec[:fields] || []
        is_batch = entity_spec["batch"] || entity_spec[:batch] || false

        results[model] = if is_batch && fields_list.any?
                           insert_batch(executor, dialect, db_table, col_map, enum_type_map, fields_list)
                         else
                           fields_list.filter_map do |fields|
                             rows = insert_one(executor, dialect, db_table, col_map, enum_type_map, fields)
                             rows.first
                           end
                         end
      end

      results
    end

    # Update a single record by primary key. Used for circular FK backfill.
    def self.update_entity(executor, dialect, table_map, column_maps, model, record_id, fields, enum_type_maps = nil)
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

      id_col = col_map["id"] || "id"
      params << record_id

      sql = "UPDATE #{dialect.quote_id(db_table)} SET #{set_clauses.join(', ')} WHERE #{dialect.quote_id(id_col)} = #{dialect.param(param_idx)}"
      executor.query(sql, params)
    end

    # --- Internal helpers ---

    def self.insert_one(executor, dialect, db_table, col_map, enum_type_map, fields)
      # Generate client-side UUID for 'id' column if not provided
      id_field_name = reverse_get(col_map, find_id_col(col_map))
      if id_field_name && !fields.key?(id_field_name)
        fields = fields.merge(id_field_name => SecureRandom.uuid)
      end

      entries = fields.to_a
      if entries.empty?
        if dialect.supports_returning
          sql = "INSERT INTO #{dialect.quote_id(db_table)} DEFAULT VALUES RETURNING *"
          return map_rows_back(executor.query(sql), col_map)
        end

        executor.query("INSERT INTO #{dialect.quote_id(db_table)} () VALUES ()")
        id_col = find_id_col(col_map)
        record_id = fields[id_field_name || "id"]
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
      id_col = find_id_col(col_map)
      record_id = fields[id_field_name || "id"]
      map_rows_back(
        executor.query(
          "SELECT * FROM #{dialect.quote_id(db_table)} WHERE #{dialect.quote_id(id_col)} = #{dialect.param(1)}",
          [record_id]
        ),
        col_map
      )
    end

    def self.insert_batch(executor, dialect, db_table, col_map, enum_type_map, fields_arr)
      return [] if fields_arr.empty?

      # Generate client-side IDs
      id_field_name = reverse_get(col_map, find_id_col(col_map))
      if id_field_name
        fields_arr = fields_arr.map do |f|
          f.key?(id_field_name) ? f : f.merge(id_field_name => SecureRandom.uuid)
        end
      end

      field_names = fields_arr.first.keys
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
        end
      end

      all_results
    end

    def self.map_rows_back(rows, col_map)
      return rows if col_map.empty?

      reverse = col_map.invert
      rows.map { |row| row.transform_keys { |k| reverse[k] || k } }
    end

    def self.find_id_col(col_map)
      col_map["id"] || "id"
    end

    def self.reverse_get(mapping, db_name)
      mapping.each { |key, val| return key if val == db_name }
      nil
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

      # JSON: stringify hashes/arrays
      return JSON.generate(value) if value.is_a?(Hash) || value.is_a?(Array)

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
        if value.match?(/\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
          return value.gsub("T", " ").gsub("Z", "").gsub(/0+\z/, "").gsub(/\.\z/, "")
        end
      end

      value
    end

    private_class_method :insert_one, :insert_batch, :map_rows_back, :find_id_col,
                         :reverse_get, :cast_param, :serialize_value
  end
end
