defmodule Autonoma.Refs do
  @moduledoc """
  JWT-like refs token: header.payload.signature using HMAC-SHA256.
  """

  @doc """
  Sign a refs payload into a 3-part token string.
  """
  def sign(payload, secret) do
    header = base64url_encode(Jason.encode!(%{"alg" => "HS256", "typ" => "REFS"}))
    # Bug 7: sanitize payload before JSON encoding to handle DateTime, NaiveDateTime, Decimal, etc.
    body = base64url_encode(Jason.encode!(sanitize_for_json(payload)))
    signature = hmac_sign("#{header}.#{body}", secret)
    "#{header}.#{body}.#{signature}"
  end

  @doc """
  Verify and decode a refs token. Returns the payload map or raises.
  """
  def verify!(token, secret) do
    parts = String.split(token, ".")

    if length(parts) != 3 do
      raise "malformed token"
    end

    [header, body, signature] = parts
    expected = hmac_sign("#{header}.#{body}", secret)

    if !Autonoma.HMAC.secure_compare(expected, signature) do
      raise "signature mismatch"
    end

    body
    |> base64url_decode()
    |> Jason.decode!()
  end

  @doc """
  Recursively sanitize values that Jason can't encode natively.
  Converts DateTime, NaiveDateTime, Date, Decimal, and other structs to strings.
  """
  def sanitize_for_json(%DateTime{} = dt), do: DateTime.to_iso8601(dt)
  def sanitize_for_json(%NaiveDateTime{} = dt), do: NaiveDateTime.to_iso8601(dt)
  def sanitize_for_json(%Date{} = d), do: Date.to_iso8601(d)
  def sanitize_for_json(%{__struct__: _} = struct) do
    # Handle Decimal and other structs by converting to string
    to_string(struct)
  end
  def sanitize_for_json(map) when is_map(map) do
    Map.new(map, fn {k, v} -> {k, sanitize_for_json(v)} end)
  end
  def sanitize_for_json(list) when is_list(list) do
    Enum.map(list, &sanitize_for_json/1)
  end
  def sanitize_for_json(tuple) when is_tuple(tuple) do
    tuple |> Tuple.to_list() |> Enum.map(&sanitize_for_json/1)
  end
  def sanitize_for_json(value), do: value

  defp base64url_encode(data) do
    Base.url_encode64(data, padding: false)
  end

  defp base64url_decode(data) do
    # Add padding back if needed
    padded =
      case rem(byte_size(data), 4) do
        2 -> data <> "=="
        3 -> data <> "="
        _ -> data
      end

    Base.url_decode64!(padded)
  end

  defp hmac_sign(data, secret) do
    :crypto.mac(:hmac, :sha256, secret, data)
    |> Base.url_encode64(padding: false)
  end
end
