defmodule Autonoma.Types do
  @moduledoc """
  Type definitions for the Autonoma SDK.

  The SDK is factory-driven: every model is owned by a registered factory
  whose input is described by `input_fields`. There is no SQL introspection,
  no executor protocol, and no dialect machinery.
  """

  # ---------------------------------------------------------------------------
  # Wire-shape types (discover response)
  # ---------------------------------------------------------------------------

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

  @type fk_edge :: %{
          from: String.t(),
          to: String.t(),
          local_field: String.t(),
          foreign_field: String.t(),
          nullable: boolean()
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

  # ---------------------------------------------------------------------------
  # Input field definition (replaces Pydantic input_model)
  # ---------------------------------------------------------------------------

  @type input_field :: %{
          name: String.t(),
          type: :string | :integer | :number | :boolean | :timestamp | :date | :uuid | :json,
          required: boolean()
        }

  # ---------------------------------------------------------------------------
  # Factory types
  # ---------------------------------------------------------------------------

  @type factory_context :: %{
          refs: %{String.t() => [map()]},
          scenario_name: String.t(),
          test_run_id: String.t()
        }

  @type factory_definition :: %{
          required(:create) => (map(), factory_context() -> map()),
          required(:input_fields) => [input_field()],
          optional(:teardown) => (map(), factory_context() -> any()) | nil,
          optional(:ref_fields) => [input_field()] | nil
        }

  @type factory_registry :: %{String.t() => factory_definition()}

  # ---------------------------------------------------------------------------
  # Handler types
  # ---------------------------------------------------------------------------

  @type hook_context :: %{
          scenario_name: String.t(),
          refs: %{String.t() => [map()]}
        }

  @type auth_context :: %{
          scope_value: String.t(),
          refs: %{String.t() => [map()]}
        }

  @type handler_config :: %{
          required(:scope_field) => String.t(),
          required(:shared_secret) => String.t(),
          required(:signing_secret) => String.t(),
          required(:auth) => (map() | nil, map() -> map()),
          optional(:factories) => factory_registry(),
          optional(:allow_production) => boolean(),
          optional(:sdk) => map(),
          optional(:before_down) => (hook_context() -> any()),
          optional(:after_up) => (hook_context(), map() -> map())
        }

  @type handler_request :: %{
          body: String.t(),
          headers: map()
        }

  @type handler_response :: %{
          status: integer(),
          body: map()
        }

  # ---------------------------------------------------------------------------
  # Payload topo types
  # ---------------------------------------------------------------------------

  @type create_op :: %{
          model: String.t(),
          fields: map(),
          temp_id: String.t()
        }

  @type resolved_tree :: %{
          ops: [create_op()],
          aliases: %{String.t() => String.t()},
          alias_owner_model: %{String.t() => String.t()},
          alias_dependencies: %{String.t() => [String.t()]}
        }
end
