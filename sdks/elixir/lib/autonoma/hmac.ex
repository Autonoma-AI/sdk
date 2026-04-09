defmodule Autonoma.HMAC do
  @moduledoc """
  HMAC-SHA256 signing and verification for request authentication.
  """

  @doc """
  Sign a body string with a secret using HMAC-SHA256.
  Returns a 64-character lowercase hex string.
  """
  def sign_body(body, secret) do
    :crypto.mac(:hmac, :sha256, secret, body)
    |> Base.encode16(case: :lower)
  end

  @doc """
  Verify a signature against a body and secret.
  Uses constant-time comparison to prevent timing attacks.
  """
  def verify_signature(body, signature, secret) do
    expected = sign_body(body, secret)

    if byte_size(expected) != byte_size(signature) do
      false
    else
      secure_compare(expected, signature)
    end
  end

  @doc """
  Constant-time string comparison to prevent timing attacks.
  """
  def secure_compare(a, b) when byte_size(a) == byte_size(b) do
    a_bytes = :binary.bin_to_list(a)
    b_bytes = :binary.bin_to_list(b)

    result =
      Enum.zip(a_bytes, b_bytes)
      |> Enum.reduce(0, fn {x, y}, acc -> Bitwise.bor(acc, Bitwise.bxor(x, y)) end)

    result == 0
  end

  def secure_compare(_, _), do: false
end
