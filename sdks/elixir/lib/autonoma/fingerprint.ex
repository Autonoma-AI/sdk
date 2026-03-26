defmodule Autonoma.Fingerprint do
  @moduledoc """
  Deterministic SHA256-based fingerprinting of scenario definitions.
  Produces a 16-character hex string, order-independent for object keys.
  """

  @doc """
  Compute a 16-char hex fingerprint of any JSON-serializable value.
  """
  def compute(value) do
    json = value |> sort_keys() |> Jason.encode!()

    :crypto.hash(:sha256, json)
    |> Base.encode16(case: :lower)
    |> binary_part(0, 16)
  end

  defp sort_keys(value) when is_map(value) do
    value
    |> Enum.sort_by(fn {k, _v} -> k end)
    |> Enum.map(fn {k, v} -> {k, sort_keys(v)} end)
    |> Jason.OrderedObject.new()
  end

  defp sort_keys(value) when is_list(value) do
    Enum.map(value, &sort_keys/1)
  end

  defp sort_keys(value), do: value
end
