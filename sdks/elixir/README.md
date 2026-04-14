# Autonoma Elixir SDK

Elixir implementation of the Autonoma Environment Factory SDK.

## Packages

| Package | Description |
|---------|-------------|
| `:autonoma` | Core protocol (HMAC, refs, graph, handler) |
| `:autonoma_ecto` | Ecto ORM adapter |
| `:autonoma_plug` | Plug server handler |

## Quick Start

### Install

Add to your `mix.exs` deps:

```elixir
defp deps do
  [
    {:autonoma, "~> 0.1"}
  ]
end
```

### Plug + Ecto

```elixir
# In your router
executor = Autonoma.Ecto.Executor.ecto_executor(MyApp.Repo)

config = %{
  executor: executor,
  scope_field: "organization_id",
  shared_secret: System.get_env("AUTONOMA_SHARED_SECRET"),
  signing_secret: System.get_env("AUTONOMA_SIGNING_SECRET"),
  auth: fn user, _context ->
    token = MyApp.Auth.create_session_token(user["id"])
    %{"headers" => %{"Authorization" => "Bearer #{token}"}}
  end
}

forward "/api/autonoma", Autonoma.Plug.Handler, config
```

## Commands

```bash
mix deps.get   # install dependencies
mix test        # run tests
```

## Documentation

For protocol-level documentation, see the root [`protocol/`](../../protocol/) directory. For a runnable example, see [`examples/elixir/phoenix-ecto/`](../../examples/elixir/phoenix-ecto/).
