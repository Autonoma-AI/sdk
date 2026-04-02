# Autonoma SDK — Phoenix + Ecto Example

A minimal Phoenix application using the Autonoma SDK with Ecto.

## What this example does

This example shows how to wire up the Autonoma Environment Factory endpoint in a Phoenix application using Ecto as the ORM. The endpoint allows Autonoma to:

1. **Discover** your database schema (models, fields, relationships)
2. **Create** test data (scoped to a test run)
3. **Tear down** test data when done

## Prerequisites

- Elixir 1.14+
- Docker (for PostgreSQL)

## Quick start

### 1. Start PostgreSQL

```bash
docker run --rm -d \
  --name autonoma-postgres \
  -e POSTGRES_USER=autonoma \
  -e POSTGRES_PASSWORD=autonoma \
  -e POSTGRES_DB=autonoma_example \
  -p 5432:5432 \
  postgres:16-alpine
```

### 2. Install dependencies and set up the database

```bash
mix deps.get
mix ecto.create
mix ecto.migrate
```

### 3. Start the server

```bash
mix phx.server
```

The server will start on http://localhost:4000.

### 4. Test it

```bash
BODY='{"action":"discover"}'
SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "my-shared-secret" | awk '{print $2}')

curl -X POST http://localhost:4000/api/autonoma \
  -H "Content-Type: application/json" \
  -H "x-signature: $SIGNATURE" \
  -d "$BODY"
```

### 5. Clean up

```bash
docker stop autonoma-postgres
```

## Project structure

```
├── lib/
│   └── autonoma_example/
│       ├── application.ex          # Application supervision tree
│       ├── repo.ex                 # Ecto repository
│       ├── router.ex               # Phoenix router (mounts Autonoma endpoint)
│       ├── endpoint.ex             # Phoenix HTTP endpoint
│       └── schemas/                # Ecto schemas (models)
│           ├── organization.ex
│           ├── user.ex
│           ├── project.ex
│           └── task.ex
├── priv/
│   └── repo/
│       └── migrations/
│           └── 20240101000000_create_tables.exs
├── config/
│   ├── config.exs
│   └── dev.exs
└── mix.exs
```

## How it works

The key integration is in the router (`lib/autonoma_example/router.ex`):

```elixir
# Create the adapter
adapter = Autonoma.Ecto.Adapter.new(
  AutonomaExample.Repo,
  [Organization, User, Project, Task],
  scope_field: "organization_id"
)

# Mount the endpoint
forward "/api/autonoma", Autonoma.Plug.Handler, %{
  adapter: adapter,
  shared_secret: "my-shared-secret",
  signing_secret: "my-signing-secret"
}
```

The Ecto adapter introspects your schemas automatically — no manual configuration needed.
