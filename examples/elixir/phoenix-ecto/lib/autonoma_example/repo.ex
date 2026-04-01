defmodule AutonomaExample.Repo do
  use Ecto.Repo,
    otp_app: :autonoma_example,
    adapter: Ecto.Adapters.Postgres
end
