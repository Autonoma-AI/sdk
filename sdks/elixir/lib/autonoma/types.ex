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

  @type handler_config :: %{
          adapter: module(),
          shared_secret: String.t(),
          signing_secret: String.t(),
          allow_production: boolean(),
          auth: (map() -> map()) | nil
        }

  @type handler_request :: %{
          body: String.t(),
          headers: map()
        }

  @type handler_response :: %{
          status: integer(),
          body: map()
        }
end
