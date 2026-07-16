defmodule Autonoma.MixProject do
  use Mix.Project

  @version "0.2.9" # x-release-please-version
  @source_url "https://github.com/Autonoma-AI/sdk"

  def project do
    [
      app: :autonoma,
      version: @version,
      elixir: "~> 1.14",
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      elixirc_paths: elixirc_paths(Mix.env()),

      # Hex
      description: "Autonoma SDK — automate the Autonoma Environment Factory endpoint",
      package: package(),
      source_url: @source_url,

      # Docs
      name: "Autonoma",
      docs: docs()
    ]
  end

  def application do
    [
      extra_applications: [:logger, :crypto]
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  defp deps do
    [
      {:jason, "~> 1.4"},
      {:plug, "~> 1.14", optional: true},
      {:ex_doc, "~> 0.34", only: :dev, runtime: false}
    ]
  end

  defp package do
    [
      name: "autonoma",
      licenses: ["MIT"],
      links: %{
        "GitHub" => @source_url,
        "Homepage" => "https://autonoma.ai"
      },
      maintainers: ["Autonoma AI"],
      files: ~w(lib mix.exs README.md LICENSE docs AGENTS.md)
    ]
  end

  defp docs do
    [
      main: "readme",
      extras: ["README.md"],
      source_ref: "v#{@version}",
      source_url: @source_url
    ]
  end
end
