defmodule Autonoma.Scenario do
  @moduledoc """
  Define a named scenario.

  A scenario's `up` is free-form code (loops, conditionals, real API calls) that
  provisions an isolated environment and returns the `auth`/`teardown` a test
  run needs. An omitted `down` is a no-op. Register scenarios with
  `%{..., scenarios: [Autonoma.Scenario.define_scenario(...)]}`.

  `up` and `down` are single-argument anonymous functions. `up` receives an up
  context (`%{test_run_id: ...}`) and returns a map with `:auth` / `:teardown`
  keys (all optional). `down` receives a down context
  (`%{name: ..., teardown: ..., test_run_id: ...}`), with `name` and `teardown`
  recovered from the verified teardown token.

  ## Example

      Autonoma.Scenario.define_scenario(
        name: "single-user",
        description: "One verified user in a fresh org",
        up: fn ctx ->
          email = Autonoma.Unique.unique_email(ctx.test_run_id)
          user = MyApp.Accounts.create_user(email: email)

          %{
            auth: %{"headers" => %{"Authorization" => "Bearer " <> user.token}},
            teardown: %{"userId" => user.id}
          }
        end,
        down: fn ctx -> MyApp.Accounts.delete_user(ctx.teardown["userId"]) end
      )
  """

  @enforce_keys [:name, :description, :up]
  defstruct [:name, :description, :up, :down]

  @type up_context :: %{test_run_id: String.t()}
  @type up_result :: %{
          optional(:auth) => map(),
          optional(:teardown) => map()
        }
  @type down_context :: %{name: String.t(), teardown: map(), test_run_id: String.t()}

  @type t :: %__MODULE__{
          name: String.t(),
          description: String.t(),
          up: (up_context() -> up_result() | nil),
          down: (down_context() -> any()) | nil
        }

  @doc """
  Validate a scenario definition and return an `Autonoma.Scenario` struct.

  Raises `ArgumentError` on misconfiguration - an invalid scenario is a
  programming error caught at process start, not a runtime condition.

  ## Options

    * `:name` (required) - a non-empty string identifier the platform calls by
    * `:description` (required) - human-readable summary shown in `discover`
    * `:up` (required) - a 1-arity function `up_context -> result`
    * `:down` (optional) - a 1-arity function `down_context -> any`
  """
  def define_scenario(opts) when is_list(opts) do
    name = Keyword.get(opts, :name)
    description = Keyword.get(opts, :description)
    up = Keyword.get(opts, :up)
    down = Keyword.get(opts, :down)

    unless is_binary(name) and name != "" do
      raise ArgumentError, ~s(Scenario "name" must be a non-empty string)
    end

    unless is_binary(description) do
      raise ArgumentError, ~s(Scenario "description" must be a string)
    end

    unless is_function(up, 1) do
      raise ArgumentError, ~s(Scenario "up" must be a 1-arity function)
    end

    unless is_nil(down) or is_function(down, 1) do
      raise ArgumentError, ~s(Scenario "down" must be a 1-arity function if provided)
    end

    %__MODULE__{name: name, description: description, up: up, down: down}
  end
end
