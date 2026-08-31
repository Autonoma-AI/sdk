# Implement the endpoint (Go)

Follow these steps to stand up a working Environment Factory endpoint. This is written for a coding agent doing the integration; do the steps in order and do not skip the validation step.

## Prerequisites

- A Go 1.25+ backend.
- A database and the client your app already uses (`database/sql`, `pgx`, GORM, sqlx, ent - it does not matter; your scenario code calls it).

## Step 1 - Install the module

The whole SDK - core handler, uniqueness helpers, and the Gin adapter - lives in one module and one package, `autonoma`:

```bash
go get github.com/autonoma-ai/sdk/sdks/go/v2/autonoma
```

```go
import "github.com/autonoma-ai/sdk/sdks/go/v2/autonoma"
```

There is no separate server adapter package to install. Gin ships in the same package as `autonoma.GinHandler`. For any other framework you read the raw request body yourself and call `autonoma.HandleRequest` directly (see Step 5). There is no ORM adapter - scenarios call your app's own code directly.

| Framework | How you mount it |
|-----------|------------------|
| Gin | `autonoma.GinHandler(config)` returns a `gin.HandlerFunc` |
| net/http, Echo, Fiber, Chi, anything else | Read the raw body, build a `HandlerRequest`, call `autonoma.HandleRequest(config, req)` |

## Step 2 - Generate the two secrets

```bash
openssl rand -hex 32   # AUTONOMA_SHARED_SECRET
openssl rand -hex 32   # AUTONOMA_SIGNING_SECRET  (must be different)
```

Add both to your environment. The handler rejects a request with `SAME_SECRETS` (HTTP 500) if the two values are equal.

```env
AUTONOMA_SHARED_SECRET=...   # shared with Autonoma
AUTONOMA_SIGNING_SECRET=...  # private, never shared
```

## Step 3 - Confirm the endpoint path and auth mechanism

There is no scope field to find in v2. Instead, confirm two things with the user before writing code:

- The endpoint path you will mount (for example `/api/autonoma`).
- How the app authenticates a request (session cookie, JWT bearer, or email + password), so your scenarios' `Up` can return real, working credentials.

## Step 4 - Write scenarios

A scenario is named code that provisions an environment. Author each with `autonoma.DefineScenario`, which takes an `autonoma.ScenarioDefinition` with a `Name`, a `Description`, an `Up`, and an optional `Down`. `Up` runs whatever provisioning code you would write by hand and returns an `autonoma.ScenarioUpResult` (`Auth`, `Teardown`, all optional). See `scenarios.md` for the authoring rules.

`DefineScenario` panics at build time if `Name` is empty or `Up` is nil, so a misconfigured scenario fails at process start rather than on the first request.

```go
// scenarios/single_user.go
package scenarios

import "github.com/autonoma-ai/sdk/sdks/go/v2/autonoma"

var SingleUser = autonoma.DefineScenario(autonoma.ScenarioDefinition{
    Name:        "single-user",
    Description: "One verified user in a fresh org",
    Up: func(ctx autonoma.ScenarioUpContext) (autonoma.ScenarioUpResult, error) {
        email := autonoma.UniqueEmail(ctx.TestRunID, "", "")
        user, err := createUser(email) // your real creation code
        if err != nil {
            return autonoma.ScenarioUpResult{}, err
        }
        token, err := mintToken(user.ID) // your real auth code
        if err != nil {
            return autonoma.ScenarioUpResult{}, err
        }
        return autonoma.ScenarioUpResult{
            Auth:     &autonoma.AuthResult{Headers: map[string]string{"Authorization": "Bearer " + token}},
            Teardown: map[string]any{"userId": user.ID},
        }, nil
    },
    Down: func(ctx autonoma.ScenarioDownContext) error {
        userID, _ := ctx.Teardown["userId"].(string)
        return deleteUser(userID)
    },
})
```

`ctx.Teardown` is a `map[string]any`, so read handles back with a type assertion (`ctx.Teardown["userId"].(string)`). Collect every scenario into one slice:

```go
// scenarios/scenarios.go
package scenarios

import "github.com/autonoma-ai/sdk/sdks/go/v2/autonoma"

var All = []autonoma.ScenarioDefinition{
    SingleUser,
    Standard,
    Large,
}
```

## Step 5 - Wire the handler

Build the config once and hand it to the adapter. The config carries the two secrets and the scenario slice. There is no `ScopeField`, no `Factories`, and no top-level auth callback.

```go
config := &autonoma.HandlerConfig{
    SharedSecret:  os.Getenv("AUTONOMA_SHARED_SECRET"),
    SigningSecret: os.Getenv("AUTONOMA_SIGNING_SECRET"),
    Scenarios:     scenarios.All,
}
```

Mount it on Gin:

```go
router.POST("/api/autonoma", autonoma.GinHandler(config))
```

On any other framework, read the raw body (before any middleware reparses it) and call `HandleRequest`. The signature is verified over the exact request bytes, so the string you pass must be the untouched body.

```go
func autonomaHandler(w http.ResponseWriter, r *http.Request) {
    body, _ := io.ReadAll(r.Body)
    headers := map[string]string{"x-signature": r.Header.Get("x-signature")}

    resp := autonoma.HandleRequest(config, autonoma.HandlerRequest{
        Body:    string(body),
        Headers: headers,
    })

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(resp.Status)
    _ = json.NewEncoder(w).Encode(resp.Body)
}
```

`HandleRequest` returns a `HandlerResponse{ Status int; Body map[string]any }`; write both to the response.

## Step 6 - Return real credentials from `Up`

The `Auth` a scenario's `Up` returns is the part that most often breaks tests, so get it right. It must be **real, working credentials** produced by the app's actual auth mechanism. A fake or hardcoded token makes every test fail at login. `Auth` is a `*autonoma.AuthResult` with `Cookies`, `Headers`, and `Credentials` - there is no `token` field.

```go
// Session cookie (most web apps)
return autonoma.ScenarioUpResult{
    Auth: &autonoma.AuthResult{
        Cookies: []autonoma.AuthCookie{{
            Name: "session", Value: session.Token, HTTPOnly: true, SameSite: "lax", Path: "/",
        }},
    },
    /* ... */
}, nil

// JWT bearer token (APIs, SPAs) - the token goes in a header
return autonoma.ScenarioUpResult{
    Auth: &autonoma.AuthResult{Headers: map[string]string{"Authorization": "Bearer " + token}},
    /* ... */
}, nil

// Email + password (the runner logs in through the UI, e.g. mobile)
return autonoma.ScenarioUpResult{
    Auth: &autonoma.AuthResult{Credentials: map[string]string{"email": user.Email, "password": "test-password-123"}},
    /* ... */
}, nil
```

For the email/password shape, the scenario must create the user with a matching password hash so a real login succeeds.

## Step 7 - Production gating (optional)

The endpoint is always enabled - HMAC signing is the gate, and unsigned requests get `401`. The `AllowProduction` field on `HandlerConfig` is deprecated and ignored (setting it just logs a one-time deprecation notice). On Autonoma preview environments (`AUTONOMA_PREVIEWKIT` is set) nothing more is needed - previews are isolated and never production. If you deploy the factory in your own environments and want it dark in production anyway, gate the route with your own condition:

```go
if os.Getenv("APP_ENV") != "production" {
    router.POST("/api/autonoma", autonoma.GinHandler(config))
}
```

## Step 8 - Validate before deploying

Go has no dry-run helper. You validate by driving `autonoma.HandleRequest` through a full `up` then `down` cycle in a `*_test.go` against a real (test) database, and iterate until it passes. See `validation.md`. Never ship a scenario you have not validated.

## Step 9 - Smoke-test with curl

```bash
SECRET="your-shared-secret"
BODY='{"action":"discover"}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/.*= //')
curl -s -X POST http://localhost:8080/api/autonoma \
  -H "Content-Type: application/json" -H "x-signature: $SIG" -d "$BODY" | jq .
```

Expected: a JSON body listing your scenarios as `{ name, description }`. A `404` means the route is not mounted; a `401` means the secret does not match.

## Step 10 - Report and connect

Tell the user the endpoint path, confirm all scenarios pass, and hand off:

1. Set `AUTONOMA_SHARED_SECRET` and `AUTONOMA_SIGNING_SECRET` in staging/production env.
2. Deploy the endpoint.
3. Paste `AUTONOMA_SHARED_SECRET` into the Autonoma dashboard when connecting the app.

## Rules

**Do:**
- Reuse the app's existing DB client and real creation code inside `Up`.
- Return real credentials from `Auth` using the app's own session/JWT logic.
- Seed every unique value from `ctx.TestRunID` with the `Unique*` helpers.
- Return a real `error` from `Up`/`Down` when provisioning or teardown fails; the handler wraps it as `INTERNAL_ERROR`.
- Match the project's conventions: package layout, import style, naming.
- Validate every scenario through a full up/down test before deploying.

**Do not:**
- Implement HMAC, token signing, or expiry yourself - the SDK owns all of it.
- Return a hardcoded token like `"test-token"` from `Auth`.
- Use the same value for `SharedSecret` and `SigningSecret`.
- Reach for a random UUID or `time.Now()` for a unique value - it breaks the determinism `Down` and debugging rely on.
