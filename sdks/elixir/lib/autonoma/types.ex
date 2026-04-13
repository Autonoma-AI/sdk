defmodule Autonoma.Types do
  @moduledoc "Type definitions for Autonoma SDK."

  @type fk_edge :: %{
          from: String.t(),
          to: String.t(),
          local_field: String.t(),
          foreign_field: String.t(),
          nullable: boolean()
        }

  @type field_info :: %{
          name: String.t(),
          type: String.t(),
          is_required: boolean(),
          is_id: boolean(),
          has_default: boolean()
        }

  @type model_info :: %{
          name: String.t(),
          table_name: String.t(),
          fields: [field_info()]
        }

  @type schema_relation :: %{
          parent_model: String.t(),
          child_model: String.t(),
          parent_field: String.t(),
          child_field: String.t()
        }

  @type schema_info :: %{
          models: [model_info()],
          edges: [fk_edge()],
          relations: [schema_relation()],
          scope_field: String.t()
        }

  # SQL executor is a 3-arity function:
  #   executor.(:query, sql, params) -> [%{column => value}]
  #   executor.(:transaction, fn tx -> ... end, nil) -> result
  # Where `tx` is a 3-arity function for query calls:
  #   tx.(:query, sql, params) -> [%{column => value}]
  @type sql_executor :: (atom(), any(), any() -> any())

  @type introspection_result :: %{
          schema: map(),
          table_map: %{String.t() => String.t()},
          column_maps: %{String.t() => %{String.t() => String.t()}},
          enum_type_maps: %{String.t() => %{String.t() => String.t()}}
        }

  @type handler_config :: %{
          optional(:executor) => sql_executor(),
          optional(:adapter) => module(),
          optional(:dialect) => String.t(),
          optional(:scope_field) => String.t(),
          optional(:db_schema) => String.t(),
          optional(:table_name_map) => %{String.t() => String.t()},
          optional(:exclude_tables) => [String.t()],
          optional(:sdk) => map(),
          optional(:sdk_server) => String.t(),
          required(:shared_secret) => String.t(),
          required(:signing_secret) => String.t(),
          optional(:allow_production) => boolean(),
          required(:auth) => (map() | nil, map() -> map())
        }

  @type handler_request :: %{
          body: String.t(),
          headers: map()
        }

  @type handler_response :: %{
          status: integer(),
          body: map()
        }

  @type create_op :: %{
          model: String.t(),
          fields: map(),
          temp_id: String.t(),
          batch: boolean()
        }

  @type deferred_update :: %{
          target_temp_id: String.t(),
          model: String.t(),
          field: String.t(),
          ref_alias: String.t()
        }
end
