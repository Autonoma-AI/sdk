defmodule Autonoma.PayloadTopo do
  @moduledoc """
  Resolve the create payload into an ordered list of operations.

  The create payload contains complete dependency information via `_alias`
  and `_ref` markers. Walking the payload to collect alias -> owner and
  owner -> {refs} gives the exact dependency graph. Kahn's topo sort over
  that graph produces the `up` order; the reverse is the `down` order.
  """

  alias Autonoma.Error

  @reserved_keys MapSet.new(["_alias", "_ref"])

  # ---------------------------------------------------------------------------
  # Walking the payload
  # ---------------------------------------------------------------------------

  @doc false
  def collect_refs(value, out) when is_map(value) do
    case Map.get(value, "_ref") do
      ref when is_binary(ref) ->
        [ref | out]

      _ ->
        Enum.reduce(value, out, fn {_k, v}, acc ->
          collect_refs(v, acc)
        end)
    end
  end

  def collect_refs(value, out) when is_list(value) do
    Enum.reduce(value, out, fn v, acc -> collect_refs(v, acc) end)
  end

  def collect_refs(_value, out), do: out

  @doc false
  def resolve_refs(value, alias_to_temp_id) when is_map(value) do
    case Map.get(value, "_ref") do
      ref when is_binary(ref) ->
        case Map.get(alias_to_temp_id, ref) do
          nil -> value
          real -> real
        end

      _ ->
        Map.new(value, fn {k, v} -> {k, resolve_refs(v, alias_to_temp_id)} end)
    end
  end

  def resolve_refs(value, alias_to_temp_id) when is_list(value) do
    Enum.map(value, fn v -> resolve_refs(v, alias_to_temp_id) end)
  end

  def resolve_refs(value, _alias_to_temp_id), do: value

  # ---------------------------------------------------------------------------
  # Tree resolution
  # ---------------------------------------------------------------------------

  @doc """
  Topo-sort a create payload into an ordered list of create ops.

  `create` is the dashboard's nested map `%{model => [entity, ...]}`.
  Each entity is a map; `_alias` (declared by dependency targets) and
  `_ref` (declared by dependents, anywhere in the field tree) are the
  only reserved keys.

  Returns `%{ops, aliases, alias_owner_model, alias_dependencies}`.
  """
  def resolve_payload_tree(create) when is_map(create) do
    # First pass: assign temp ids and collect alias declarations.
    {raw_entries, aliases, alias_owner_model} = first_pass(create)

    # Second pass: collect each entry's dependency aliases and strip reserved keys.
    {deps_by_temp_id, fields_by_temp_id, model_by_temp_id} =
      second_pass(raw_entries, aliases)

    # Build the temp_id graph and topo-sort.
    sorted_temp_ids = topo_sort(raw_entries, deps_by_temp_id, aliases, model_by_temp_id)

    # Build alias_dependencies
    alias_dependencies =
      Map.new(aliases, fn {alias_name, temp_id} ->
        deps = Map.get(deps_by_temp_id, temp_id, [])
        {alias_name, deps}
      end)

    # Build CreateOp list in topo order.
    ops =
      Enum.map(sorted_temp_ids, fn tid ->
        %{
          model: Map.fetch!(model_by_temp_id, tid),
          fields: Map.fetch!(fields_by_temp_id, tid),
          temp_id: tid
        }
      end)

    %{
      ops: ops,
      aliases: aliases,
      alias_owner_model: alias_owner_model,
      alias_dependencies: alias_dependencies
    }
  end

  def resolve_payload_tree(_create) do
    raise Error.invalid_body("`create` must be an object keyed by model name")
  end

  defp first_pass(create) do
    {raw_entries, _counter, aliases, alias_owner_model} =
      Enum.reduce(create, {[], 0, %{}, %{}}, fn {model, entities}, {entries, counter, aliases, aom} ->
        unless is_list(entities) do
          raise Error.invalid_body(
                  "`create.#{model}` must be a list of entity objects, got #{inspect(entities)}"
                )
        end

        Enum.reduce(entities, {entries, counter, aliases, aom}, fn entity, {entries, counter, aliases, aom} ->
          unless is_map(entity) do
            raise Error.invalid_body(
                    "`create.#{model}` entries must be objects, got #{inspect(entity)}"
                  )
          end

          temp_id = "__temp_#{model}_#{counter}"
          alias_val = Map.get(entity, "_alias")

          {aliases, aom, alias_str} =
            cond do
              is_binary(alias_val) ->
                if Map.has_key?(aliases, alias_val) do
                  raise Error.invalid_body("duplicate _alias \"#{alias_val}\"")
                end

                {Map.put(aliases, alias_val, temp_id), Map.put(aom, alias_val, model), alias_val}

              is_nil(alias_val) ->
                {aliases, aom, nil}

              true ->
                raise Error.invalid_body("\"_alias\" must be a string")
            end

          entry = {model, temp_id, entity, alias_str}
          {entries ++ [entry], counter + 1, aliases, aom}
        end)
      end)

    {raw_entries, aliases, alias_owner_model}
  end

  defp second_pass(raw_entries, aliases) do
    Enum.reduce(raw_entries, {%{}, %{}, %{}}, fn {model, temp_id, entity, _alias}, {deps_map, fields_map, model_map} ->
      {deps, cleaned} =
        Enum.reduce(entity, {[], %{}}, fn {key, value}, {deps, cleaned} ->
          if MapSet.member?(@reserved_keys, key) do
            {deps, cleaned}
          else
            new_deps = collect_refs(value, deps)
            resolved_value = resolve_refs(value, aliases)
            {new_deps, Map.put(cleaned, key, resolved_value)}
          end
        end)

      # Check for unknown aliases
      unknown = Enum.filter(deps, fn a -> not Map.has_key?(aliases, a) end)

      if unknown != [] do
        unique_unknown = unknown |> Enum.uniq() |> Enum.sort() |> Enum.join(", ")

        raise Error.invalid_body(
                "`create.#{model}` references unknown alias(es): #{unique_unknown}"
              )
      end

      {
        Map.put(deps_map, temp_id, deps),
        Map.put(fields_map, temp_id, cleaned),
        Map.put(model_map, temp_id, model)
      }
    end)
  end

  defp topo_sort(raw_entries, deps_by_temp_id, aliases, model_by_temp_id) do
    # Build payload order map for stable tie-breaking
    payload_order =
      raw_entries
      |> Enum.with_index()
      |> Map.new(fn {{_model, temp_id, _entity, _alias}, idx} -> {temp_id, idx} end)

    # Build in-degree and adjacency
    in_degree = Map.new(raw_entries, fn {_model, temp_id, _entity, _alias} -> {temp_id, 0} end)

    {in_degree, edges} =
      Enum.reduce(deps_by_temp_id, {in_degree, %{}}, fn {temp_id, deps}, {in_deg, adj} ->
        seen = MapSet.new()

        Enum.reduce(deps, {in_deg, adj, seen}, fn dep_alias, {in_deg, adj, seen} ->
          dep_temp_id = Map.fetch!(aliases, dep_alias)

          if dep_temp_id == temp_id or MapSet.member?(seen, dep_temp_id) do
            {in_deg, adj, seen}
          else
            seen = MapSet.put(seen, dep_temp_id)
            adj = Map.update(adj, dep_temp_id, [temp_id], fn existing -> existing ++ [temp_id] end)
            in_deg = Map.update!(in_deg, temp_id, fn d -> d + 1 end)
            {in_deg, adj, seen}
          end
        end)
        |> then(fn {in_deg, adj, _seen} -> {in_deg, adj} end)
      end)

    # Kahn's algorithm, preserving payload order as stable tie-breaker
    ready =
      in_degree
      |> Enum.filter(fn {_tid, deg} -> deg == 0 end)
      |> Enum.map(fn {tid, _} -> tid end)
      |> Enum.sort_by(fn t -> Map.get(payload_order, t, 0) end)

    sorted = kahns_loop(ready, edges, in_degree, payload_order, [])

    if length(sorted) != map_size(payload_order) do
      cycle_tids =
        in_degree
        |> Enum.filter(fn {_tid, deg} -> deg > 0 end)
        |> Enum.sort_by(fn {t, _} -> Map.get(payload_order, t, 0) end)
        |> Enum.map(fn {t, _} -> t end)

      cycle_models = Enum.map_join(cycle_tids, ", ", fn t -> Map.fetch!(model_by_temp_id, t) end)
      raise Error.invalid_body("cycle detected in _alias/_ref graph: #{cycle_models}")
    end

    sorted
  end

  defp kahns_loop([], _edges, _in_degree, _payload_order, sorted), do: sorted

  defp kahns_loop([tid | rest], edges, in_degree, payload_order, sorted) do
    neighbors = Map.get(edges, tid, [])

    {new_ready, in_degree} =
      Enum.reduce(neighbors, {[], in_degree}, fn nxt, {new_ready, in_deg} ->
        new_val = Map.get(in_deg, nxt, 1) - 1
        in_deg = Map.put(in_deg, nxt, new_val)

        if new_val == 0 do
          {[nxt | new_ready], in_deg}
        else
          {new_ready, in_deg}
        end
      end)

    ready =
      (rest ++ new_ready)
      |> Enum.sort_by(fn t -> Map.get(payload_order, t, 0) end)

    kahns_loop(ready, edges, in_degree, payload_order, sorted ++ [tid])
  end

  # ---------------------------------------------------------------------------
  # Teardown ordering
  # ---------------------------------------------------------------------------

  @doc """
  Order models for teardown.

  With `alias_dependencies` available (newer refs tokens carry it),
  we run the same Kahn's topo sort over models and return the reverse
  topo so children are torn down before parents.

  Without it (older refs tokens), fall back to reversing the insertion
  order of `refs` keys.
  """
  def compute_teardown_order(refs, alias_dependencies, alias_owner_model)
      when is_map(refs) do
    models = Map.keys(refs)

    if is_nil(alias_dependencies) or alias_dependencies == %{} or
         is_nil(alias_owner_model) or alias_owner_model == %{} do
      Enum.reverse(models)
    else
      # Build model -> {model dependencies}
      model_deps =
        Map.new(models, fn m -> {m, MapSet.new()} end)

      model_deps =
        Enum.reduce(alias_dependencies, model_deps, fn {alias_name, deps}, model_deps ->
          owner = Map.get(alias_owner_model, alias_name)

          if is_nil(owner) or not Map.has_key?(model_deps, owner) do
            model_deps
          else
            Enum.reduce(deps, model_deps, fn dep_alias, model_deps ->
              dep_model = Map.get(alias_owner_model, dep_alias)

              if is_nil(dep_model) or dep_model == owner or not Map.has_key?(model_deps, dep_model) do
                model_deps
              else
                Map.update!(model_deps, owner, fn s -> MapSet.put(s, dep_model) end)
              end
            end)
          end
        end)

      # Kahn's over models
      payload_order = models |> Enum.with_index() |> Map.new()

      in_degree = Map.new(models, fn m -> {m, 0} end)
      adj = %{}

      {in_degree, adj} =
        Enum.reduce(model_deps, {in_degree, adj}, fn {owner, deps}, {in_deg, adj} ->
          Enum.reduce(deps, {in_deg, adj}, fn dep_model, {in_deg, adj} ->
            adj = Map.update(adj, dep_model, [owner], fn existing -> existing ++ [owner] end)
            in_deg = Map.update!(in_deg, owner, fn d -> d + 1 end)
            {in_deg, adj}
          end)
        end)

      ready =
        in_degree
        |> Enum.filter(fn {_m, d} -> d == 0 end)
        |> Enum.map(fn {m, _} -> m end)
        |> Enum.sort_by(fn m -> Map.get(payload_order, m, 0) end)

      up_order = kahns_model_loop(ready, adj, in_degree, payload_order, [])

      if length(up_order) != length(models) do
        # Shouldn't happen - cycles rejected at up. Fall back.
        Enum.reverse(models)
      else
        Enum.reverse(up_order)
      end
    end
  end

  defp kahns_model_loop([], _adj, _in_degree, _payload_order, sorted), do: sorted

  defp kahns_model_loop([m | rest], adj, in_degree, payload_order, sorted) do
    neighbors = Map.get(adj, m, [])

    {new_ready, in_degree} =
      Enum.reduce(neighbors, {[], in_degree}, fn nxt, {new_ready, in_deg} ->
        new_val = Map.get(in_deg, nxt, 1) - 1
        in_deg = Map.put(in_deg, nxt, new_val)

        if new_val == 0 do
          {[nxt | new_ready], in_deg}
        else
          {new_ready, in_deg}
        end
      end)

    ready =
      (rest ++ new_ready)
      |> Enum.sort_by(fn m -> Map.get(payload_order, m, 0) end)

    kahns_model_loop(ready, adj, in_degree, payload_order, sorted ++ [m])
  end
end
