defmodule Autonoma.Schema do
  @moduledoc """
  Build the SDK's wire-shape schema from registered factories.

  The dashboard's `discover` response carries a `schema` block that lists
  every model the host can create, along with each model's fields. With
  the factory-driven design, this comes from each factory's `input_fields`
  list rather than SQL introspection.
  """

  @doc """
  Map an Elixir type atom to the SDK's coarse type string.

  The SDK emits a handful of canonical names (`string`, `integer`,
  `number`, `boolean`, `timestamp`, `date`, `uuid`, `json`) so the
  dashboard can render appropriate input controls.
  """
  def field_type_from_annotation(type) do
    case type do
      :string -> "string"
      :integer -> "integer"
      :number -> "number"
      :boolean -> "boolean"
      :timestamp -> "timestamp"
      :date -> "date"
      :uuid -> "uuid"
      :json -> "json"
      _ -> "string"
    end
  end

  @doc """
  Build the SDK's discover-time schema from registered factories.

  `factories` is a map of `%{model_name => factory_definition}`.
  Each factory definition must include `input_fields`.

  `edges` and `relations` are emitted as empty lists. They were populated
  from FK introspection in the old design; here the create payload's
  `_alias` / `_ref` graph carries equivalent information at request time.
  """
  def build_schema_from_factories(factories, scope_field) when is_map(factories) do
    models =
      Enum.map(factories, fn {entity, factory} ->
        input_fields = Map.get(factory, :input_fields)

        unless is_list(input_fields) do
          raise ArgumentError,
                "Factory \"#{entity}\" has no input_fields. " <>
                  "Every factory must declare input_fields in `define_factory(...)`."
        end

        fields = input_fields_to_field_infos(input_fields)

        %{
          name: entity,
          table_name: camel_to_snake(entity),
          fields: fields
        }
      end)

    %{
      models: models,
      edges: [],
      relations: [],
      scope_field: scope_field
    }
  end

  @doc """
  Serialise a schema info map to the JSON shape the dashboard expects.

  Field names in the wire JSON are camelCase (e.g. `isRequired`).
  """
  def schema_to_wire(schema) do
    %{
      "models" =>
        Enum.map(schema.models, fn m ->
          %{
            "name" => m.name,
            "tableName" => m.table_name,
            "fields" =>
              Enum.map(m.fields, fn f ->
                %{
                  "name" => f.name,
                  "type" => f.type,
                  "isRequired" => f.is_required,
                  "isId" => f.is_id,
                  "hasDefault" => f.has_default
                }
              end)
          }
        end),
      "edges" =>
        Enum.map(schema.edges, fn e ->
          %{
            "from" => e.from_model,
            "to" => e.to_model,
            "localField" => e.local_field,
            "foreignField" => e.foreign_field,
            "nullable" => e.nullable
          }
        end),
      "relations" =>
        Enum.map(schema.relations, fn r ->
          %{
            "parentModel" => r.parent_model,
            "childModel" => r.child_model,
            "parentField" => r.parent_field,
            "childField" => r.child_field
          }
        end),
      "scopeField" => schema.scope_field
    }
  end

  # ---------------------------------------------------------------------------
  # Internal helpers
  # ---------------------------------------------------------------------------

  defp input_fields_to_field_infos(input_fields) do
    # Every model gets a synthetic `id` field at the head
    id_field = %{
      name: "id",
      type: "string",
      is_required: false,
      is_id: true,
      has_default: true
    }

    user_fields =
      Enum.map(input_fields, fn field ->
        %{
          name: Map.fetch!(field, :name),
          type: field_type_from_annotation(Map.fetch!(field, :type)),
          is_required: Map.get(field, :required, false),
          is_id: false,
          has_default: not Map.get(field, :required, false)
        }
      end)

    [id_field | user_fields]
  end

  defp camel_to_snake(name) do
    name
    |> String.graphemes()
    |> Enum.with_index()
    |> Enum.map(fn {ch, i} ->
      if i > 0 and ch =~ ~r/[A-Z]/ and not (String.at(name, i - 1) =~ ~r/[A-Z]/) do
        "_" <> String.downcase(ch)
      else
        String.downcase(ch)
      end
    end)
    |> Enum.join()
  end
end
