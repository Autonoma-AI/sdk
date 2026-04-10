defmodule Autonoma.Tree do
  @moduledoc "Resolve a nested scenario tree into an ordered list of create operations."

  @reserved_keys MapSet.new(["_alias", "_ref"])

  defmodule Result do
    @moduledoc false
    defstruct ops: [], deferred_updates: [], aliases: %{}
  end

  def resolve_tree(create, schema) do
    relations = schema["relations"] || []
    edges = schema["edges"] || []

    # Index relations by "parentModel.parentField"
    rel_by_pf = Map.new(relations, fn r -> {"#{r["parentModel"]}.#{r["parentField"]}", r} end)

    # Determine FK direction
    fk_on_parent =
      Enum.reduce(relations, MapSet.new(), fn rel, acc ->
        edge = Enum.find(edges, fn e ->
          e["localField"] == rel["childField"] &&
            (e["from"] == rel["parentModel"] || e["from"] == rel["childModel"])
        end)

        if edge && edge["from"] == rel["parentModel"] do
          MapSet.put(acc, "#{rel["parentModel"]}.#{rel["parentField"]}")
        else
          acc
        end
      end)

    state = %{
      result: %Result{},
      rel_by_pf: rel_by_pf,
      fk_on_parent: fk_on_parent,
      counter: 0
    }

    state =
      Enum.reduce(create, state, fn {model_name, nodes}, st ->
        Enum.reduce(nodes, st, fn node, s ->
          {_temp_id, s} = walk_node(s, model_name, node, nil, nil, false)
          s
        end)
      end)

    state.result
  end

  defp walk_node(state, model_name, node, parent_temp_id, parent_relation, parent_fk_on_parent) do
    {temp_id, state} = make_temp_id(state, model_name)
    alias_name = Map.get(node, "_alias")

    # Classify node entries
    {fields, pre_children, post_children, state} =
      Enum.reduce(node, {%{}, [], [], state}, fn {key, value}, {f, pre, post, st} ->
        if MapSet.member?(@reserved_keys, key) do
          {f, pre, post, st}
        else
          exact_key = "#{model_name}.#{key}"
          lm = String.downcase(String.first(model_name)) <> String.slice(model_name, 1..-1//1)
          prefixed_key = "#{model_name}.#{lm}#{String.capitalize(String.first(key))}#{String.slice(key, 1..-1//1)}"

          {relation, matched_key} =
            cond do
              Map.has_key?(st.rel_by_pf, exact_key) -> {st.rel_by_pf[exact_key], exact_key}
              Map.has_key?(st.rel_by_pf, prefixed_key) -> {st.rel_by_pf[prefixed_key], prefixed_key}
              true ->
                # Fallback: match by child model name
                found = Enum.find(st.rel_by_pf, fn {rk, rel} ->
                  String.starts_with?(rk, "#{model_name}.") && String.downcase(rel["childModel"]) == String.downcase(key)
                end)
                case found do
                  {rk, rel} -> {rel, rk}
                  nil -> {nil, nil}
                end
            end

          if relation do
            if MapSet.member?(st.fk_on_parent, matched_key) do
              {f, pre ++ [{relation, value, true}], post, st}
            else
              {f, pre, post ++ [{relation, value, false}], st}
            end
          else
            # Handle _ref
            if is_map(value) && Map.has_key?(value, "_ref") do
              ref_alias = value["_ref"]
              ref_temp_id = Map.get(st.result.aliases, ref_alias)

              if ref_temp_id do
                {Map.put(f, key, ref_temp_id), pre, post, st}
              else
                du = %{target_temp_id: temp_id, model: model_name, field: key, ref_alias: ref_alias}
                result = %{st.result | deferred_updates: st.result.deferred_updates ++ [du]}
                {f, pre, post, %{st | result: result}}
              end
            else
              {Map.put(f, key, value), pre, post, st}
            end
          end
        end
      end)

    # Wire FK to parent
    fields =
      if parent_relation && parent_temp_id && !parent_fk_on_parent do
        Map.put(fields, parent_relation["childField"], parent_temp_id)
      else
        fields
      end

    # Process pre-children
    {fields, state} =
      Enum.reduce(pre_children, {fields, state}, fn {relation, value, _}, {f, st} ->
        if is_list(value) do
          Enum.reduce(value, {f, st}, fn child, {ff, ss} ->
            {child_temp_id, ss} = walk_node(ss, relation["childModel"], child, temp_id, relation, true)
            {Map.put(ff, relation["childField"], child_temp_id), ss}
          end)
        else
          {f, st}
        end
      end)

    # Create this node
    op = %{model: model_name, fields: fields, temp_id: temp_id, batch: false}
    result = %{state.result | ops: state.result.ops ++ [op]}
    result = if alias_name, do: %{result | aliases: Map.put(result.aliases, alias_name, temp_id)}, else: result
    state = %{state | result: result}

    # Process post-children
    state =
      Enum.reduce(post_children, state, fn {relation, value, _}, st ->
        if is_list(value) do
          Enum.reduce(value, st, fn child, s ->
            {_id, s} = walk_node(s, relation["childModel"], child, temp_id, relation, false)
            s
          end)
        else
          st
        end
      end)

    {temp_id, state}
  end

  defp make_temp_id(state, model) do
    id = "__temp_#{model}_#{state.counter}"
    {id, %{state | counter: state.counter + 1}}
  end
end
