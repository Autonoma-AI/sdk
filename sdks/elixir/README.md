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

## Model name ↔ table name

By default, the SDK derives a model name from each SQL table by splitting on `_` and PascalCasing each part — **no pluralization**. Examples:

| SQL table | Auto-derived model name |
|-----------|-------------------------|
| `user` | `User` |
| `api_key` | `ApiKey` |
| `branch_deployment` | `BranchDeployment` |
| `organizations` | `Organizations` (stays plural) |
| `api_keys` | `ApiKeys` (stays plural) |

If every factory you register is keyed under the auto-derived name, **omit `:table_name_map` entirely**. The SDK handles the mapping.

You only need `:table_name_map` when a factory key disagrees with the auto-derived name. Common reasons:

- Your tables are plural but you want singular factory keys: `organizations` table ↔ `"Organization"` key.
- Legacy short names: `usr` table ↔ `"User"` key, `acl` table ↔ `"AccessControl"` key.

The map is **sparse, not exhaustive**: only list entries that actually differ. Auto-derivation covers the rest.

```elixir
# Tables in DB: organization, user, api_key, deal   (singular)
# Factories keyed: "Organization", "User", "ApiKey", "Deal"
# :table_name_map omitted — auto-derive is exact

# Tables in DB: organizations, users, api_keys
# Factories keyed singular → every entry disagrees:
config = %{
  # ...
  table_name_map: %{
    "Organization" => "organizations",
    "User" => "users",
    "ApiKey" => "api_keys"
  },
  factories: %{"Organization" => ..., "User" => ..., "ApiKey" => ...}
}
```

**Red flag:** if your `:table_name_map` has one entry per factory and every entry is just a plural↔singular rename, consider keeping factory keys plural (`"Organizations"`) and dropping the map entirely. Plural keys are valid — pick whichever convention your scenarios use.

## Commands

```bash
mix deps.get   # install dependencies
mix test        # run tests
```

## Documentation

For protocol-level documentation, see the root [`protocol/`](../../protocol/) directory. For a runnable example, see [`examples/elixir/phoenix-ecto/`](../../examples/elixir/phoenix-ecto/).
