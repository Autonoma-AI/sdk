defmodule Autonoma.Template do
  @moduledoc """
  Template expression resolution for {{...}} expressions in entity specs.
  """

  @template_re ~r/\{\{(.+?)\}\}/

  @doc """
  Resolve all {{...}} expressions in a value.
  Handles strings, maps, lists recursively.
  """
  def resolve(value, ctx) when is_binary(value) do
    resolve_string(value, ctx)
  end

  def resolve(value, ctx) when is_list(value) do
    Enum.map(value, fn v -> resolve(v, ctx) end)
  end

  def resolve(value, ctx) when is_map(value) do
    Map.new(value, fn {k, v} -> {k, resolve(v, ctx)} end)
  end

  def resolve(value, _ctx), do: value

  defp resolve_string(str, ctx) do
    # If the entire string is a single expression, return the raw value (preserving type)
    case Regex.run(~r/^\{\{(.+?)\}\}$/, str) do
      [_, expr] ->
        evaluate_expression(String.trim(expr), ctx)

      nil ->
        # Interpolate expressions into the string
        Regex.replace(@template_re, str, fn _, expr ->
          expr |> String.trim() |> evaluate_expression(ctx) |> to_string()
        end)
    end
  end

  defp evaluate_expression("testRunId", ctx), do: ctx["testRunId"] || ctx[:testRunId]
  defp evaluate_expression("index", ctx), do: ctx["index"] || ctx[:index]

  defp evaluate_expression("index1", ctx) do
    index = ctx["index"] || ctx[:index]
    index + 1
  end

  defp evaluate_expression("now()", _ctx) do
    DateTime.utc_now() |> DateTime.to_iso8601()
  end

  defp evaluate_expression(expr, ctx) do
    cond do
      String.starts_with?(expr, "cycle(") ->
        items = parse_array_literal(expr, "cycle")
        index = ctx["index"] || ctx[:index]
        Enum.at(items, rem(index, length(items)))

      String.starts_with?(expr, "pick(") ->
        items = parse_array_literal(expr, "pick")
        Enum.random(items)

      String.starts_with?(expr, "random.int(") ->
        {min, max} = parse_range(expr, "random.int")
        min + :rand.uniform(max - min + 1) - 1

      String.starts_with?(expr, "random.float(") ->
        {min, max} = parse_range(expr, "random.float")
        :rand.uniform() * (max - min) + min

      String.starts_with?(expr, "daysAgo(") ->
        n = parse_single_int(expr, "daysAgo")
        DateTime.utc_now()
        |> DateTime.add(-n * 86400, :second)
        |> DateTime.to_iso8601()

      true ->
        raise "Template error: unknown expression '#{expr}'"
    end
  end

  defp parse_array_literal(expr, fn_name) do
    # Extract the array content: fn_name([...])
    inner =
      expr
      |> String.trim_leading("#{fn_name}([")
      |> String.trim_trailing("])")

    inner
    |> String.split(",")
    |> Enum.map(fn s ->
      s = String.trim(s)

      cond do
        String.starts_with?(s, "'") && String.ends_with?(s, "'") ->
          String.slice(s, 1..-2//1)

        String.starts_with?(s, "\"") && String.ends_with?(s, "\"") ->
          String.slice(s, 1..-2//1)

        true ->
          s
      end
    end)
  end

  defp parse_range(expr, fn_name) do
    inner =
      expr
      |> String.trim_leading("#{fn_name}(")
      |> String.trim_trailing(")")

    [a, b] = String.split(inner, ",") |> Enum.map(&String.trim/1)

    if fn_name == "random.int" do
      {String.to_integer(a), String.to_integer(b)}
    else
      {parse_number(a), parse_number(b)}
    end
  end

  defp parse_number(s) do
    case Float.parse(s) do
      {f, ""} -> f
      _ -> String.to_integer(s) * 1.0
    end
  end

  defp parse_single_int(expr, fn_name) do
    expr
    |> String.trim_leading("#{fn_name}(")
    |> String.trim_trailing(")")
    |> String.trim()
    |> String.to_integer()
  end
end
