defmodule Autonoma.Ecto.Executor do
  @moduledoc """
  Creates a SQL executor function backed by an Ecto Repo.

  The returned function handles:
  - `executor.(:query, sql, params)` — runs raw SQL via `Ecto.Adapters.SQL.query!/3`
  - `executor.(:transaction, fn tx -> ... end)` — wraps in `Repo.transaction/1`

  ## Usage

      executor = Autonoma.Ecto.Executor.ecto_executor(MyApp.Repo)
      config = %{executor: executor, dialect: "postgres", scope_field: "organizationId", ...}
  """

  @doc "Create a SQL executor function from an Ecto Repo module."
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
end
