defmodule Autonoma.TestRepo do
  use Ecto.Repo,
    otp_app: :autonoma,
    adapter: Ecto.Adapters.SQLite3
end
