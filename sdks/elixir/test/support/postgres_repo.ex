defmodule Autonoma.PostgresTestRepo do
  use Ecto.Repo,
    otp_app: :autonoma,
    adapter: Ecto.Adapters.Postgres
end
