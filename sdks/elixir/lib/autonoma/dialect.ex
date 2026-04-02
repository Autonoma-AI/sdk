defmodule Autonoma.Dialect do
  @moduledoc "Database dialect abstraction — generates dialect-specific SQL strings."

  defmodule Postgres do
    @moduledoc false

    alias Autonoma.Generated.SQLQueries

    def name, do: "postgres"
    def supports_returning, do: true
    def param(i), do: "$#{i}"
    def quote_id(name), do: ~s("#{name}")

    def tables_sql(schema), do: Autonoma.Dialect.do_replace(SQLQueries.postgres_tables(), schema)
    def columns_sql(schema), do: Autonoma.Dialect.do_replace(SQLQueries.postgres_columns(), schema)
    def primary_keys_sql(schema), do: Autonoma.Dialect.do_replace(SQLQueries.postgres_primary_keys(), schema)
    def foreign_keys_sql(schema), do: Autonoma.Dialect.do_replace(SQLQueries.postgres_foreign_keys(), schema)
    def enums_sql(_schema), do: SQLQueries.postgres_enums()
  end

  defmodule MySQL do
    @moduledoc false

    alias Autonoma.Generated.SQLQueries

    def name, do: "mysql"
    def supports_returning, do: false
    def param(_i), do: "?"
    def quote_id(name), do: "`#{name}`"

    def tables_sql(schema), do: Autonoma.Dialect.do_replace(SQLQueries.mysql_tables(), schema)
    def columns_sql(schema), do: Autonoma.Dialect.do_replace(SQLQueries.mysql_columns(), schema)
    def primary_keys_sql(schema), do: Autonoma.Dialect.do_replace(SQLQueries.mysql_primary_keys(), schema)
    def foreign_keys_sql(schema), do: Autonoma.Dialect.do_replace(SQLQueries.mysql_foreign_keys(), schema)
    def enums_sql(_schema), do: SQLQueries.mysql_enums()
  end

  @doc false
  def do_replace(template, schema) do
    String.replace(template, "{{schema}}", schema)
  end

  def get("postgres"), do: Postgres
  def get("mysql"), do: MySQL
  def get(name), do: raise("Dialect \"#{name}\" is not yet supported.")
end
