# Autonoma Elixir SDK

Elixir implementation of the Autonoma Environment Factory SDK.

## Packages

| Package | Description |
|---------|-------------|
| `:autonoma` | Core protocol (HMAC, refs, graph, handler, schema) |
| `:autonoma_plug` | Plug server handler |

## Quick Start

### Install

Add to your `mix.exs` deps:

```elixir
defp deps do
  [
    {:autonoma, "~> 0.2"}
  ]
end
```

### Plug + Factories

```elixir
# In your router
factories = %{
  "Organization" => Autonoma.Factory.define_factory(%{
    create: fn data, ctx ->
      org = MyApp.Repo.insert!(%MyApp.Organization{name: data["name"]})
      %{"id" => org.id, "name" => org.name}
    end,
    input_fields: [%{name: "name", type: "string", required: true}],
    teardown: fn record, ctx ->
      MyApp.Repo.delete!(%MyApp.Organization{id: record["id"]})
    end
  })
}

config = %{
  scope_field: "organization_id",
  shared_secret: System.get_env("AUTONOMA_SHARED_SECRET"),
  signing_secret: System.get_env("AUTONOMA_SIGNING_SECRET"),
  factories: factories,
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

Full agent-facing docs ship inside the Hex package under [`docs/`](./docs/) (start with [`docs/implement.md`](./docs/implement.md)); [`AGENTS.md`](./AGENTS.md) is the agent pointer. For the language-agnostic wire protocol, see the root [`protocol/`](../../protocol/) directory.
