# Implement the endpoint (Elixir)

Follow these steps to stand up a working Environment Factory endpoint. This is written for a coding agent doing the integration; do the steps in order and do not skip the validation step.

## Prerequisites

- An Elixir app on `elixir ~> 1.14`, mounting HTTP through Plug or Phoenix.
- A database and the client your app already uses (Ecto, or anything else). Your scenario code calls it directly.

## Step 1 - Add the dependencies

The core package is the `autonoma` Hex package. `:plug` is an **optional** dependency of `autonoma`; add it explicitly to pull in the `Autonoma.Plug.Handler` adapter (Phoenix already depends on Plug, so you usually have it).

```elixir
# mix.exs
defp deps do
  [
    {:autonoma, "~> 2.0"},
    {:plug, "~> 1.14"}
    # ... your existing deps
  ]
end
```

```bash
mix deps.get
```

There is only one server adapter in Elixir - `Autonoma.Plug.Handler` - and it serves both plain Plug and Phoenix. There is no ORM adapter: scenarios call your app's own code (Ecto contexts, service modules) directly.

## Step 2 - Generate the two secrets

```bash
openssl rand -hex 32   # AUTONOMA_SHARED_SECRET
openssl rand -hex 32   # AUTONOMA_SIGNING_SECRET  (must be different)
```

Read them at runtime (`config/runtime.exs` or `System.fetch_env!/1`), never at compile time, so a release picks up the deployed values. The handler raises `SAME_SECRETS` at request time if the two are equal.

```elixir
# config/runtime.exs
config :my_app, :autonoma,
  shared_secret: System.fetch_env!("AUTONOMA_SHARED_SECRET"),
  signing_secret: System.fetch_env!("AUTONOMA_SIGNING_SECRET")
```

## Step 3 - Confirm the endpoint path and auth mechanism

There is no scope field to find in v2. Instead, confirm two things with the user before writing code:

- The endpoint path you will mount (for example `/api/autonoma`).
- How the app authenticates a request (session cookie, JWT bearer, or email + password), so your scenarios' `up` can return real, working credentials.

## Step 4 - Write scenarios

A scenario is named code that provisions an environment. Author each with `Autonoma.Scenario.define_scenario/1`, which takes a **keyword list** and returns an `%Autonoma.Scenario{}` struct. You pass a `:name`, a `:description`, an `:up`, and an optional `:down`. `up` and `down` are 1-arity anonymous functions `fn ctx -> ... end`, not module callbacks. See `scenarios.md` for the authoring rules.

```elixir
# lib/my_app/autonoma/scenarios.ex
defmodule MyApp.Autonoma.Scenarios do
  def single_user do
    Autonoma.Scenario.define_scenario(
      name: "single-user",
      description: "One verified user in a fresh org",
      up: fn ctx ->
        email = Autonoma.Unique.unique_email(ctx.test_run_id)
        user = MyApp.Accounts.create_user(email: email, verified: true)

        %{
          auth: %{"headers" => %{"Authorization" => "Bearer " <> user.token}},
          teardown: %{"userId" => user.id}
        }
      end,
      down: fn ctx -> MyApp.Accounts.delete_user(ctx.teardown["userId"]) end
    )
  end

  def all, do: [single_user(), standard(), large()]
end
```

`up`'s `ctx` is a map with the atom key `:test_run_id` (`ctx.test_run_id`). The map `up` returns may use atom or string keys for `:auth` / `:teardown` - both are accepted. `down`'s `ctx` is `%{name: ..., teardown: ..., test_run_id: ...}` (atom keys), recovered from the verified teardown token.

## Step 5 - Wire the handler

The core entry point is `Autonoma.Handler.handle(config, req)`. In Plug or Phoenix you never call it directly - you `forward` the path to `Autonoma.Plug.Handler` and hand it the config as the plug options. The config is a **plain map** carrying the two secrets and the scenario array.

```elixir
# lib/my_app_web/router.ex  (Phoenix)
defmodule MyAppWeb.Router do
  use MyAppWeb, :router

  forward "/api/autonoma", Autonoma.Plug.Handler, MyApp.Autonoma.config()
end
```

```elixir
# lib/my_app/autonoma.ex
defmodule MyApp.Autonoma do
  def config do
    cfg = Application.fetch_env!(:my_app, :autonoma)

    %{
      shared_secret: Keyword.fetch!(cfg, :shared_secret),
      signing_secret: Keyword.fetch!(cfg, :signing_secret),
      scenarios: MyApp.Autonoma.Scenarios.all()
    }
  end
end
```

The config map keys are `:shared_secret`, `:signing_secret`, `:scenarios`, plus optional `:expires_in_seconds` and `:sdk`. There is no `:scope_field`, no `:factories` registry, and no top-level `:auth` callback - auth is returned per scenario from `up`. (`:allow_production` is accepted but deprecated and ignored.)

**Raw body requirement.** The HMAC signature is computed over the raw, unparsed request bytes. `Autonoma.Plug.Handler` calls `read_body/1` itself, so mount the `forward` so it reaches the plug before any JSON body parser consumes the stream. In a Phoenix endpoint, keep `/api/autonoma` out of the pipeline that runs `Plug.Parsers`, or the parser will drain the body and every request will fail signature verification.

## Step 6 - Return real credentials from `up`

The `auth` a scenario's `up` returns is the part that most often breaks tests, so get it right. It must be **real, working credentials** produced by the app's actual auth mechanism. A fake or hardcoded token makes every test fail at login. `auth` is a map keyed by the strings `"cookies"`, `"headers"`, and/or `"credentials"` - there is no top-level `token` field.

```elixir
# Session cookie (most web apps)
%{"cookies" => [%{name: "session", value: session.token, http_only: true, same_site: "lax", path: "/"}]}

# JWT bearer token (APIs, SPAs) - the token goes in a header
%{"headers" => %{"Authorization" => "Bearer " <> token}}

# Email + password (the runner logs in through the UI, e.g. mobile)
%{"credentials" => %{"email" => user.email, "password" => "test-password-123"}}
```

For the email/password shape, the scenario must create the user with a matching password hash so a real login succeeds.

## Step 7 - Production gating (optional)

The endpoint is always enabled - HMAC signing is the gate, and unsigned requests get `401`. The old `:allow_production` flag is deprecated and ignored (it logs a one-time deprecation warning). On Autonoma preview environments (`AUTONOMA_PREVIEWKIT` is set) nothing more is needed - previews are isolated and never production. If you deploy the factory in your own environments and want it dark in production anyway, gate the `forward` in your router with a condition you own:

```elixir
# lib/my_app_web/router.ex
if Application.compile_env(:my_app, :env) != :prod do
  forward "/api/autonoma", Autonoma.Plug.Handler, MyApp.Autonoma.config()
end
```

## Step 8 - Validate before deploying

There is no `check_scenario` helper in the Elixir SDK. Validate by driving every scenario through a full `up` then `down` cycle against a real test database in an ExUnit test, and iterate until each passes. See `validation.md`. Never ship a scenario you have not validated.

## Step 9 - Smoke-test with curl

```bash
SECRET="your-shared-secret"
BODY='{"action":"discover"}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/.*= //')
curl -s -X POST http://localhost:4000/api/autonoma \
  -H "Content-Type: application/json" -H "x-signature: $SIG" -d "$BODY" | jq .
```

Expected: a JSON body listing your scenarios as `{ name, description }`, plus `version` and `sdk` metadata. A `404` means the route is not mounted; a `401` means the secret does not match (or a body parser drained the raw bytes - see Step 5).

## Step 10 - Report and connect

Tell the user the endpoint path, confirm all scenarios pass, and hand off:

1. Set `AUTONOMA_SHARED_SECRET` and `AUTONOMA_SIGNING_SECRET` in staging/production env.
2. Deploy the endpoint.
3. Paste `AUTONOMA_SHARED_SECRET` into the Autonoma dashboard when connecting the app.

## Rules

**Do:**
- Reuse the app's existing DB client and real creation code (Ecto contexts, service modules) inside `up`.
- Return real credentials from `auth` using the app's own session/JWT logic.
- Seed every unique value from `test_run_id` with the `Autonoma.Unique.*` helpers.
- Match the project's conventions: module layout, naming, formatting.
- Validate every scenario through a real up/down cycle before deploying.

**Do not:**
- Implement HMAC, token signing, or expiry yourself - the SDK owns all of it.
- Return a hardcoded token like `"test-token"` from `auth`.
- Use the same value for `:shared_secret` and `:signing_secret`.
- Reach for a random UUID or `System.system_time/0` for a unique value - it breaks the determinism `down` and debugging rely on.
