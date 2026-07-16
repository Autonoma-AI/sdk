# Implement the endpoint (Go)

Follow these steps to stand up a working Environment Factory endpoint. This is written for a coding agent doing the integration; do the steps in order and do not skip the validation step.

## Prerequisites

- A Go backend (module-based, Go 1.24+).
- The database client your app already uses (GORM, `sqlx`, `pgx`, `database/sql` - it does not matter; your factories call it).
- Gin, if that is your HTTP framework. For any other framework you wire `autonoma.HandleRequest` by hand (Step 5).

## Step 1 - Install the package

```bash
# shell
go get github.com/autonoma-ai/sdk-go/autonoma
```

Import it as `github.com/autonoma-ai/sdk-go/autonoma`. There is no ORM adapter package to install - the SDK is factory-driven. The only server adapter that ships is Gin (`autonoma.GinHandler`); everything else uses `autonoma.HandleRequest` directly.

## Step 2 - Generate the two secrets

```bash
# shell
openssl rand -hex 32   # AUTONOMA_SHARED_SECRET
openssl rand -hex 32   # AUTONOMA_SIGNING_SECRET  (must be different)
```

Add both to your environment (and placeholders to `.env.example` if it exists). The handler returns `SAME_SECRETS` (500) on every request if they match.

## Step 3 - Find the scope field

Read the database schema. Find the foreign key that appears on the most models and points at a single root entity - commonly `organizationId`, `orgId`, `tenantId`, or `workspaceId`. That is the scope field. The root model itself (e.g. `Organization`) does not carry it.

Confirm the field, the endpoint path, and the app's auth mechanism with the user before writing code.

## Step 4 - Write a factory per model

Write one factory for each model the platform will create, calling your app's real creation code. See `factories.md` for the full contract. Collect them into one registry keyed by model name:

```go
// factories/registry.go
package factories

import "github.com/autonoma-ai/sdk-go/autonoma"

var Registry = autonoma.FactoryRegistry{
	"Organization": Organization,
	"User":         User,
	"Member":       Member,
}
```

## Step 5 - Wire the handler

Build one `*autonoma.HandlerConfig` and mount it. The config carries the scope field, both secrets, the factory registry, the gate flag, and the auth callback.

```go
// autonoma_endpoint.go
package main

import (
	"github.com/gin-gonic/gin"

	"github.com/autonoma-ai/sdk-go/autonoma"
	"myapp/auth"
	"myapp/factories"
)

func mountAutonoma(r *gin.Engine) {
	config := &autonoma.HandlerConfig{
		ScopeField:      "organizationId",
		SharedSecret:    os.Getenv("AUTONOMA_SHARED_SECRET"),
		SigningSecret:   os.Getenv("AUTONOMA_SIGNING_SECRET"),
		Factories:       factories.Registry,
		AllowProduction: true, // see Step 7
		Auth: func(user map[string]any, ctx autonoma.AuthContext) (map[string]any, error) {
			session, err := auth.CreateSession(user["id"].(string)) // your app's real session code
			if err != nil {
				return nil, err
			}
			return map[string]any{
				"cookies": []map[string]any{
					{"name": "session", "value": session.Token, "httpOnly": true, "sameSite": "lax", "path": "/"},
				},
			}, nil
		},
	}

	r.POST("/api/autonoma", autonoma.GinHandler(config))
}
```

`GinHandler` reads the raw body, forwards the `x-signature` header, and sets `sdk.server` to `"gin"` for you.

### Without Gin: wire HandleRequest by hand

There is no `net/http` adapter, but `autonoma.HandleRequest` is the framework-agnostic entry point. Read the raw body untouched, pass the headers, and write the returned status and JSON body:

```go
// autonoma_nethttp.go
func autonomaHandler(config *autonoma.HandlerConfig) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		headers := map[string]string{}
		for k := range r.Header {
			headers[strings.ToLower(k)] = r.Header.Get(k)
		}
		resp := autonoma.HandleRequest(config, autonoma.HandlerRequest{
			Body:    string(body),
			Headers: headers,
		})
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.Status)
		json.NewEncoder(w).Encode(resp.Body)
	}
}
```

The HMAC is computed over the exact request bytes, so read the body as a raw string before any middleware reparses it.

## Step 6 - Implement the auth callback

This is the part that most often breaks tests, so get it right. The callback signature is:

```go
// signature
Auth func(user map[string]any, ctx autonoma.AuthContext) (map[string]any, error)
```

- `user` - the first created `User` record (matched case-insensitively on the model name `user`/`users`), exactly as your factory returned it, or `nil` if the scenario made none. Guard for `nil` before indexing it.
- `ctx` - `autonoma.AuthContext{ ScopeValue string; Refs map[string][]map[string]any }`.
- **Return** - a `map[string]any` that becomes the response `auth` object. It must contain **real, working credentials** built with the app's actual auth mechanism. If it returns a fake or hardcoded token, every test fails at login.

There is no top-level `token` field. Use the keys `cookies`, `headers`, and/or `credentials` - pick the shape that matches how your app authenticates:

```go
// auth_shapes.go

// Session cookie (most web apps)
return map[string]any{
	"cookies": []map[string]any{
		{"name": "session", "value": session.Token, "httpOnly": true, "sameSite": "lax", "path": "/"},
	},
}, nil

// JWT bearer token (APIs, SPAs) - the token goes in a header
return map[string]any{
	"headers": map[string]any{"Authorization": "Bearer " + token},
}, nil

// Email + password (the runner logs in through the UI, e.g. mobile)
return map[string]any{
	"credentials": map[string]any{"email": user["email"], "password": "test-password-123"},
}, nil
```

For the email/password shape, the `User` factory must create the record with a matching password hash, so a real login succeeds.

## Step 7 - Enable the endpoint

The handler returns `404 PRODUCTION_BLOCKED` until `AllowProduction` is `true`. The SDK never inspects `GO_ENV`, `NODE_ENV`, or any environment variable - this flag is the only switch, so you own the condition:

```go
// gate.go
AllowProduction: true,                              // always on
AllowProduction: os.Getenv("APP_ENV") != "production", // off in prod
```

## Step 8 - Validate before deploying

Dry-run your scenarios against a real (test) database and iterate until they pass. Go has no `checkScenario` helper - you drive `autonoma.HandleRequest` from a Go test. See `validation.md`. Never ship a scenario you have not validated.

## Step 9 - Smoke-test with curl

```bash
# shell
SECRET="your-shared-secret"
BODY='{"action":"discover"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/.*= //')
curl -s -X POST http://localhost:8080/api/autonoma \
  -H "Content-Type: application/json" -H "x-signature: $SIG" -d "$BODY" | jq .
```

Expected: a JSON schema listing your models and `scopeField`. A `404` means `AllowProduction` is not set or the route is not mounted; a `401` means the secret does not match.

## Step 10 - Report and connect

Tell the user the endpoint path, confirm all scenarios pass, and hand off:

1. Set `AUTONOMA_SHARED_SECRET` and `AUTONOMA_SIGNING_SECRET` in staging/production env.
2. Deploy the endpoint.
3. Paste `AUTONOMA_SHARED_SECRET` into the Autonoma dashboard when connecting the app.

## Rules

**Do:**
- Reuse the app's existing DB client and real creation code inside factories.
- Return real credentials from `Auth` using the app's own session/JWT logic.
- Register a factory (with a `Teardown`) for every model any scenario creates.
- Match the project's conventions: package layout, error handling, naming.
- Validate every scenario with a Go test driving `HandleRequest` before deploying.

**Do not:**
- Implement HMAC, token signing, or teardown ordering yourself - the SDK owns all of it.
- Return a hardcoded token like `"test-token"` from `Auth`.
- Use the same value for `SharedSecret` and `SigningSecret`.
- Set `id`, defaulted fields, or auto timestamps in scenario data.
- Expect the SDK to inject the scope field or wire any FK - you set every FK as a `_ref`.
