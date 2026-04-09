# Autonoma Elixir SDK

Elixir implementation of the Autonoma Environment Factory SDK.

## Packages

| Package | Description |
|---------|-------------|
| `:autonoma` | Core protocol (HMAC, refs, templates, graph, handler) |
| `:autonoma_ecto` | Ecto ORM adapter |
| `:autonoma_plug` | Plug server handler |

## Quick Start

### Install

Add to your `mix.exs` deps:

```elixir
defp deps do
  [
    {:autonoma, path: "path/to/autonoma"},
    # optional:
    {:autonoma_ecto, path: "path/to/autonoma_ecto"},
    {:autonoma_plug, path: "path/to/autonoma_plug"},
  ]
end
```

### Plug + Ecto

```elixir
# In your router
config = %{
  shared_secret: System.get_env("AUTONOMA_SHARED_SECRET"),
  signing_secret: System.get_env("AUTONOMA_SIGNING_SECRET"),
  adapter: MyApp.AutonomaAdapter,
  auth: fn user ->
    token = MyApp.Auth.create_session_token(user["id"])
    %{"headers" => %{"Authorization" => "Bearer #{token}"}}
  end
}

plug Autonoma.Plug.Handler, config
```

## Status

The Elixir SDK core modules (graph, hmac, refs, fingerprint, template) are complete and pass the conformance test suite. The Ecto adapter is a stub. Requires local Elixir to build and test.

## Commands

```bash
mix deps.get   # install dependencies
mix test        # run tests
```

## Documentation

For protocol-level documentation, see the root [`protocol/`](../../protocol/) directory.
