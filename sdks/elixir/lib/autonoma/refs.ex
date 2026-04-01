defmodule Autonoma.Refs do
  @moduledoc """
  JWT-like refs token: header.payload.signature using HMAC-SHA256.
  """

  @doc """
  Sign a refs payload into a 3-part token string.
  """
  def sign(payload, secret) do
    header = base64url_encode(Jason.encode!(%{"alg" => "HS256", "typ" => "REFS"}))
    body = base64url_encode(Jason.encode!(payload))
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

    if expected != signature do
      raise "signature mismatch"
    end

    body
    |> base64url_decode()
    |> Jason.decode!()
  end

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
