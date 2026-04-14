# Autonoma SDK -- Gin + database/sql Example

A minimal Gin application using the Autonoma SDK with Go's `database/sql` and PostgreSQL.

## What this example does

This example shows how to wire up the Autonoma Environment Factory endpoint in a Gin app using `database/sql`. The endpoint allows Autonoma to discover your schema, create test data, and tear it down.

## Prerequisites

- Go 1.21+
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

### 2. Install dependencies

```bash
go mod tidy
```

### 3. Start the server

The app automatically creates the database tables on startup.

```bash
go run main.go
```

The server will start on http://localhost:3000.

### 4. Test it

```bash
BODY='{"action":"discover"}'
SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "my-shared-secret" | awk '{print $2}')

curl -X POST http://localhost:3000/api/autonoma \
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
├── main.go     # Gin server + Autonoma endpoint + table creation
├── go.mod      # Go module definition
└── README.md
```

## How it works

The key integration in `main.go`:

```go
config := &autonoma.HandlerConfig{
    Executor:      autonoma.NewSQLExecutor(db),
    ScopeField:    "organization_id",
    Dialect:       "postgres",
    SharedSecret:  sharedSecret,
    SigningSecret:  signingSecret,
    Auth: func(user map[string]any, ctx autonoma.AuthContext) (*autonoma.AuthResult, error) {
        return &autonoma.AuthResult{
            Extra: map[string]any{
                "headers": map[string]any{
                    "Authorization": "Bearer test-token",
                },
            },
        }, nil
    },
}

r := gin.Default()
r.POST("/api/autonoma", autonoma.GinHandler(config))
```
