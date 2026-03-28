defmodule AutonomaExample.MixProject do
  use Mix.Project

  def project do
    [
      app: :autonoma_example,
      version: "0.1.0",
      elixir: "~> 1.14",
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      aliases: aliases()
    ]
  end

  def application do
    [
      extra_applications: [:logger],
      mod: {AutonomaExample.Application, []}
    ]
  end

  defp deps do
    [
      # Web framework
      {:phoenix, "~> 1.7"},
      {:plug_cowboy, "~> 2.7"},
      {:jason, "~> 1.4"},

      # Database
      {:ecto_sql, "~> 3.10"},
      {:postgrex, "~> 0.19"},

      # Autonoma SDK
      {:autonoma, "~> 0.1"}
    ]
  end

  defp aliases do
    [
      setup: ["deps.get", "ecto.create", "ecto.migrate"]
    ]
  end
end
