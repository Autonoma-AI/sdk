defmodule Autonoma.Unique do
  @moduledoc """
  Deterministic uniqueness helpers seeded from `testRunId`.

  A scenario's `data` needs stable keys across runs but unique values per run
  (unique emails, org slugs, ids). These derive that uniqueness from
  `(testRunId, ...parts)`: the same inputs always produce the same output within
  a run, so a scenario's `up` and a later `down` compute identical values
  without storing them.

  The recipe is `sha256(testRunId <> (" " <> part) for each part)`, hex-encoded,
  truncated to the first 12 chars - and MUST match the other language SDKs
  byte-for-byte for cross-language conformance.
  """

  @token_length 12

  @doc "A short hex token, deterministic per `(test_run_id, parts)`."
  def unique_token(test_run_id, parts \\ []) do
    binary_part(digest(test_run_id, parts), 0, @token_length)
  end

  @doc """
  An id like `user_1a2b3c4d5e6f`, deterministic per inputs. An empty prefix
  defaults to `id`.
  """
  def unique_id(test_run_id, prefix \\ "id", parts \\ []) do
    prefix = if prefix == "", do: "id", else: prefix
    prefix <> "_" <> unique_token(test_run_id, [prefix | parts])
  end

  @doc """
  A URL-safe slug like `acme-1a2b3c4d5e6f`, deterministic per inputs. An empty
  base defaults to `item`.
  """
  def unique_slug(test_run_id, base \\ "item", parts \\ []) do
    base = if base == "", do: "item", else: base
    token = unique_token(test_run_id, [base | parts])

    normalized =
      base
      |> String.downcase()
      |> String.replace(~r/[^a-z0-9]+/, "-")
      |> String.replace(~r/^-+|-+$/, "")

    normalized = if normalized == "", do: "item", else: normalized
    normalized <> "-" <> token
  end

  @doc """
  An email like `user+1a2b3c4d5e6f@example.com`, deterministic per inputs. Empty
  local/domain default to `user`/`example.com`.
  """
  def unique_email(test_run_id, local \\ "user", domain \\ "example.com") do
    local = if local == "", do: "user", else: local
    domain = if domain == "", do: "example.com", else: domain
    local <> "+" <> unique_token(test_run_id, [local, domain]) <> "@" <> domain
  end

  defp digest(test_run_id, parts) do
    data = Enum.reduce(parts, test_run_id, fn part, acc -> acc <> " " <> to_string(part) end)

    :crypto.hash(:sha256, data)
    |> Base.encode16(case: :lower)
  end
end
