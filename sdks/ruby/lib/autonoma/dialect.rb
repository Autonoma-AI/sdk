# frozen_string_literal: true

require_relative "generated/sql_queries"

module Autonoma
  module Dialect
    def self.get_dialect(name = "postgres")
      case name
      when "postgres"
        PostgresDialect.new
      when "mysql"
        MySQLDialect.new
      else
        raise ArgumentError, "Dialect \"#{name}\" is not yet supported. Currently only \"postgres\" and \"mysql\" are available."
      end
    end
  end

  class PostgresDialect
    def name
      "postgres"
    end

    def supports_returning
      true
    end

    def param(index)
      "$#{index}"
    end

    def quote_id(name)
      "\"#{name}\""
    end

    def tables_sql(schema)
      replace_schema(SqlQueries::POSTGRES_TABLES, schema)
    end

    def columns_sql(schema)
      replace_schema(SqlQueries::POSTGRES_COLUMNS, schema)
    end

    def primary_keys_sql(schema)
      replace_schema(SqlQueries::POSTGRES_PRIMARY_KEYS, schema)
    end

    def foreign_keys_sql(schema)
      replace_schema(SqlQueries::POSTGRES_FOREIGN_KEYS, schema)
    end

    def enums_sql(_schema)
      SqlQueries::POSTGRES_ENUMS
    end

    private

    def replace_schema(template, schema)
      template.gsub("{{schema}}", schema)
    end
  end

  class MySQLDialect
    def name
      "mysql"
    end

    def supports_returning
      false
    end

    def param(_index)
      "?"
    end

    def quote_id(name)
      "`#{name}`"
    end

    def tables_sql(schema)
      replace_schema(SqlQueries::MYSQL_TABLES, schema)
    end

    def columns_sql(schema)
      replace_schema(SqlQueries::MYSQL_COLUMNS, schema)
    end

    def primary_keys_sql(schema)
      replace_schema(SqlQueries::MYSQL_PRIMARY_KEYS, schema)
    end

    def foreign_keys_sql(schema)
      replace_schema(SqlQueries::MYSQL_FOREIGN_KEYS, schema)
    end

    def enums_sql(_schema)
      SqlQueries::MYSQL_ENUMS
    end

    private

    def replace_schema(template, schema)
      template.gsub("{{schema}}", schema)
    end
  end
end
