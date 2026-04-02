defmodule Autonoma.Ecto.Adapter do
  @moduledoc """
  Ecto implementation of the Autonoma.Adapter behaviour.
  Requires a repo module and a list of Ecto schema modules to introspect.

  ## Usage

      adapter = Autonoma.Ecto.Adapter.new(MyApp.Repo, [Organization, User, App], scope_field: "organization_id")
      config = %{adapter: adapter, shared_secret: "...", signing_secret: "..."}
  """

  import Ecto.Query

  defstruct [:repo, :schemas, :scope_field, :schema_map, :cached_schema]

  def new(repo, schemas, opts \\ []) do
    scope_field = Keyword.get(opts, :scope_field, "organization_id")
    schema_map = Map.new(schemas, fn mod -> {inspect(mod) |> String.split(".") |> List.last(), mod} end)

    %__MODULE__{
      repo: repo,
      schemas: schemas,
      scope_field: scope_field,
      schema_map: schema_map,
      cached_schema: nil
    }
  end

  @doc "Returns the adapter name for protocol metadata."
  def name(_adapter), do: "ecto"

  @doc """
  Creates a SQL executor function backed by an Ecto Repo.

  The returned function handles:
  - `executor.(:query, sql, params)` — runs raw SQL via `Ecto.Adapters.SQL.query!/3`
  - `executor.(:transaction, fn tx -> ... end)` — wraps in `Repo.transaction/1`

  ## Usage

      executor = Autonoma.Ecto.Adapter.ecto_executor(MyApp.Repo)
      config = %{executor: executor, dialect: "postgres", scope_field: "organizationId", ...}
  """
  def ecto_executor(repo) do
    fn
      :query, sql, params ->
        result = Ecto.Adapters.SQL.query!(repo, sql, params || [])
        columns = Enum.map(result.columns || [], &to_string/1)
        Enum.map(result.rows || [], fn row ->
          Enum.zip(columns, row) |> Map.new()
        end)

      :transaction, fun, _opts ->
        tx = fn :query, sql, params ->
          result = Ecto.Adapters.SQL.query!(repo, sql, params || [])
          columns = Enum.map(result.columns || [], &to_string/1)
          Enum.map(result.rows || [], fn row ->
            Enum.zip(columns, row) |> Map.new()
          end)
        end

        repo.transaction(fn -> fun.(tx) end)
        |> case do
          {:ok, result} -> result
          {:error, reason} -> raise "Transaction failed: #{inspect(reason)}"
        end
    end
  end

  @doc "Introspect Ecto schemas to build protocol-compatible schema info."
  def get_schema(%__MODULE__{cached_schema: cached} = adapter) when not is_nil(cached), do: {cached, adapter}

  def get_schema(%__MODULE__{schemas: schemas, scope_field: scope_field} = adapter) do
    {models, edges, relations} =
      Enum.reduce(schemas, {[], [], []}, fn mod, {models_acc, edges_acc, rels_acc} ->
        model_name = inspect(mod) |> String.split(".") |> List.last()
        fields = introspect_fields(mod)
        model_edges = introspect_edges(mod, model_name, adapter)
        model_rels = introspect_relations(mod, model_name, adapter)

        {
          models_acc ++ [%{"name" => model_name, "fields" => fields}],
          edges_acc ++ model_edges,
          rels_acc ++ model_rels
        }
      end)

    schema = %{
      "models" => models,
      "edges" => edges,
      "relations" => relations,
      "scopeField" => scope_field
    }

    {schema, %{adapter | cached_schema: schema}}
  end

  @doc "Create entities from a spec map. Processes models in FK-safe topological order."
  def create_entities(%__MODULE__{repo: repo, schema_map: schema_map} = adapter, spec, _context) do
    {schema, _adapter} = get_schema(adapter)
    model_names = Map.keys(spec)
    %{"sorted" => sorted} = Autonoma.Graph.topo_sort(model_names, schema["edges"])
    # Add any models not in sorted (no edges) at the end
    ordered = sorted ++ (model_names -- sorted)

    repo.transaction(fn ->
      Enum.reduce(ordered, %{}, fn model_name, acc ->
        case Map.get(spec, model_name) do
          nil -> acc
          entity_spec ->
            schema_mod = Map.fetch!(schema_map, model_name)
            fields_list = entity_spec["fields"] || []

            records =
              Enum.map(fields_list, fn field_data ->
                attrs = atomize_keys(field_data, schema_mod)
                changeset = schema_mod.__struct__() |> Ecto.Changeset.cast(attrs, Map.keys(attrs))
                record = repo.insert!(changeset)
                record_to_map(record, schema_mod)
              end)

            Map.put(acc, model_name, records)
        end
      end)
    end)
  end

  @doc "Tear down all data scoped to a value in reverse topological order."
  def teardown(%__MODULE__{repo: repo, schemas: _schemas, schema_map: schema_map, scope_field: scope_field} = adapter, scope_value, _refs) do
    {schema, _adapter} = get_schema(adapter)
    model_names = Enum.map(schema["models"], fn m -> m["name"] end)
    %{"sorted" => sorted, "cycles" => cycles} = Autonoma.Graph.topo_sort(model_names, schema["edges"])

    # Find scope root model
    scope_root =
      Enum.find_value(schema["edges"], fn edge ->
        if edge["localField"] == scope_field && edge["to"] != edge["from"], do: edge["to"]
      end)

    # Build map: model -> FK field pointing to scope root
    scope_fk_by_model =
      if scope_root do
        schema["edges"]
        |> Enum.filter(fn e -> e["to"] == scope_root && e["from"] != scope_root end)
        |> Map.new(fn e -> {e["from"], e["localField"]} end)
      else
        %{}
      end

    repo.transaction(fn ->
      # Break cycles
      for cycle <- cycles do
        edge = Autonoma.Graph.find_deferrable_edge(cycle, schema["edges"])

        if edge do
          from_mod = Map.get(schema_map, edge["from"])
          scope_fk = Map.get(scope_fk_by_model, edge["from"])

          if from_mod && scope_fk do
            scope_atom = String.to_existing_atom(scope_fk)
            local_atom = String.to_existing_atom(edge["localField"])

            from(r in from_mod, where: field(r, ^scope_atom) == ^scope_value)
            |> repo.update_all(set: [{local_atom, nil}])
          end
        end
      end

      # Delete cycle nodes
      for cycle <- cycles, model_name <- cycle do
        delete_model(repo, schema_map, model_name, scope_value, scope_fk_by_model, scope_root)
      end

      # Delete in reverse topo order
      for model_name <- Enum.reverse(sorted), model_name != scope_root do
        delete_model(repo, schema_map, model_name, scope_value, scope_fk_by_model, scope_root)
      end

      # Delete scope root last
      if scope_root do
        root_mod = Map.get(schema_map, scope_root)

        if root_mod do
          pk_field = root_mod.__schema__(:primary_key) |> List.first()
          from(r in root_mod, where: field(r, ^pk_field) == ^scope_value) |> repo.delete_all()
        end
      end
    end)

    :ok
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  defp introspect_fields(mod) do
    fields = mod.__schema__(:fields)
    pk_fields = mod.__schema__(:primary_key)
    autogenerate = mod.__schema__(:autogenerate_fields)

    Enum.map(fields, fn field_name ->
      type = mod.__schema__(:type, field_name)

      %{
        "name" => to_string(field_name),
        "type" => to_string(type),
        "isRequired" => true,
        "isId" => field_name in pk_fields,
        "hasDefault" => field_name in pk_fields || field_name in autogenerate
      }
    end)
  end

  defp introspect_edges(mod, model_name, _adapter) do
    associations = mod.__schema__(:associations)

    associations
    |> Enum.map(fn assoc_name -> mod.__schema__(:association, assoc_name) end)
    |> Enum.filter(fn assoc -> match?(%Ecto.Association.BelongsTo{}, assoc) end)
    |> Enum.map(fn %Ecto.Association.BelongsTo{} = assoc ->
      target_name =
        inspect(assoc.related) |> String.split(".") |> List.last()

      %{
        "from" => model_name,
        "to" => target_name,
        "localField" => to_string(assoc.owner_key),
        "foreignField" => to_string(assoc.related_key),
        "nullable" => false
      }
    end)
  end

  defp introspect_relations(mod, model_name, _adapter) do
    associations = mod.__schema__(:associations)

    associations
    |> Enum.map(fn assoc_name -> {assoc_name, mod.__schema__(:association, assoc_name)} end)
    |> Enum.filter(fn {_, assoc} -> match?(%Ecto.Association.BelongsTo{}, assoc) end)
    |> Enum.map(fn {assoc_name, %Ecto.Association.BelongsTo{} = assoc} ->
      %{
        "parentModel" => model_name,
        "childModel" => inspect(assoc.related) |> String.split(".") |> List.last(),
        "parentField" => to_string(assoc_name),
        "childField" => to_string(assoc.owner_key)
      }
    end)
  end

  defp delete_model(repo, schema_map, model_name, scope_value, scope_fk_by_model, _scope_root) do
    mod = Map.get(schema_map, model_name)

    if mod do
      scope_fk = Map.get(scope_fk_by_model, model_name)

      if scope_fk do
        scope_atom = String.to_existing_atom(scope_fk)
        from(r in mod, where: field(r, ^scope_atom) == ^scope_value) |> repo.delete_all()
      end
    end
  end

  defp atomize_keys(map, schema_mod) do
    known_fields = schema_mod.__schema__(:fields) |> Enum.map(&to_string/1) |> MapSet.new()

    map
    |> Enum.filter(fn {k, _v} -> MapSet.member?(known_fields, to_string(k)) end)
    |> Map.new(fn {k, v} -> {String.to_existing_atom(to_string(k)), v} end)
  end

  defp record_to_map(record, schema_mod) do
    fields = schema_mod.__schema__(:fields)
    Map.new(fields, fn f -> {to_string(f), Map.get(record, f)} end)
  end
end
