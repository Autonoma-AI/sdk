# Implement the endpoint (Ruby)

Follow these steps to stand up a working Environment Factory endpoint in a Rails or Rack app. This is written for a coding agent doing the integration; do the steps in order and do not skip the validation step.

## Prerequisites

- Ruby 3.1+.
- A Rails app (or any Rack app) and the models / creation code your app already uses. Your factories call it.
- No ORM adapter and no schema library to install - the SDK is factory-driven and depends only on the standard library.

## Step 1 - Install the gem

Add the core gem to your `Gemfile` and bundle:

```ruby
# Gemfile
gem "autonoma-ai"
```

```bash
bundle install
```

The gem name is `autonoma-ai`. It provides two modules: `Autonoma` (core protocol) and `AutonomaRails` (the Rails controller mixin and Rack middleware). There is no separate adapter gem.

## Step 2 - Generate the two secrets

```bash
openssl rand -hex 32   # AUTONOMA_SHARED_SECRET
openssl rand -hex 32   # AUTONOMA_SIGNING_SECRET  (must be different)
```

The SDK raises `SAME_SECRETS` at request time if they match. Store both in the environment (Rails credentials or `ENV`); never commit them.

## Step 3 - Find the scope field

Read the database schema. Find the foreign key that appears on the most models and points at a single root entity - commonly `organizationId`, `orgId`, `tenantId`, or `workspaceId`. That is the scope field. The root model itself (e.g. `Organization`) does not carry it.

Confirm the field, the endpoint path, and the app's auth mechanism with the user before writing code.

## Step 4 - Write a factory per model

Write one factory for each model the platform will create, calling your app's real creation code. See `factories.md` for the full contract. Collect them into one hash keyed by model name:

```ruby
# app/autonoma/factories.rb
AUTONOMA_FACTORIES = {
  "Organization" => AppFactories::ORGANIZATION,
  "User" => AppFactories::USER,
  "Member" => AppFactories::MEMBER
}
```

## Step 5 - Wire the endpoint

Build one `Autonoma::HandlerConfig` and hand it to the Rails controller mixin. The config carries the scope field, both secrets, the factory hash, the gate flag, and the auth callback.

```ruby
# config/routes.rb
post "/api/autonoma", to: "autonoma#handle"
```

```ruby
# app/controllers/autonoma_controller.rb
require "autonoma_rails/server"

class AutonomaController < ApplicationController
  include AutonomaRails::Handler

  skip_before_action :verify_authenticity_token

  def handle
    autonoma_handle(autonoma_config)
  end

  private

  def autonoma_config
    @autonoma_config ||= Autonoma::HandlerConfig.new(
      scope_field: "organizationId",
      shared_secret: ENV.fetch("AUTONOMA_SHARED_SECRET"),
      signing_secret: ENV.fetch("AUTONOMA_SIGNING_SECRET"),
      factories: AUTONOMA_FACTORIES,
      allow_production: true, # see Step 7
      auth: ->(user, ctx) {
        session = create_session(user["id"]) # your app's real session code
        { "cookies" => [{ "name" => "session", "value" => session.token, "httpOnly" => true, "sameSite" => "lax", "path" => "/" }] }
      }
    )
  end
end
```

`skip_before_action :verify_authenticity_token` is required - the request is not a browser form, and the SDK authenticates it with HMAC, not a CSRF token.

### Config keys

`HandlerConfig` is a keyword-init struct. `scope_field`, `shared_secret`, `signing_secret`, and `auth` are required; the rest have defaults.

| Key | Required | Meaning |
|-----|----------|---------|
| `scope_field` | yes | The single column that isolates test data, e.g. `"organizationId"`. |
| `shared_secret` | yes | Verifies incoming requests (HMAC). Shared with Autonoma. |
| `signing_secret` | yes | Signs the teardown token. Private to you. Must differ from `shared_secret`. |
| `auth` | yes | Callable returning real login credentials (see Step 6). |
| `factories` | effectively yes | Hash of model name to `FactoryDefinition`. `up` fails if empty. |
| `allow_production` | no (default `false`) | The gate flag (see Step 7). |
| `before_down` / `after_up` | no | Optional hooks. `after_up` receives `(ctx, auth)` and returns the (possibly modified) auth; `before_down` receives `(ctx)`. |
| `sdk` | no | Metadata hash; the Rails adapter sets `server` to `"rails"`. |

### Rack middleware alternative

If you are not on Rails controllers, mount the Rack middleware instead. It handles only `POST` to its `path` and passes everything else through:

```ruby
# config.ru
require "autonoma_rails/server"

config = Autonoma::HandlerConfig.new(
  scope_field: "organizationId",
  shared_secret: ENV.fetch("AUTONOMA_SHARED_SECRET"),
  signing_secret: ENV.fetch("AUTONOMA_SIGNING_SECRET"),
  factories: AUTONOMA_FACTORIES,
  allow_production: true,
  auth: ->(user, ctx) { { "headers" => { "Authorization" => "Bearer #{issue_jwt(user['id'])}" } } }
)

use AutonomaRails::Middleware, config, path: "/api/autonoma"
```

## Step 6 - Implement the auth callback

This is the part that most often breaks tests, so get it right. The callback is `->(user, ctx)`:

- `user` - the first created `User` record (the hash your `User` factory returned), matched case-insensitively on the model name `User`/`Users`. It is `nil` if the scenario created none. Read fields as `user["id"]`.
- `ctx` - an `AuthContext` struct with `ctx.scope_value` (the detected scope field value) and `ctx.refs`.

It must return **real, working credentials** using the app's actual auth mechanism. If it returns a fake or hardcoded token, every test fails at login. The return value is a hash with string keys `"cookies"`, `"headers"`, and/or `"credentials"` - there is **no top-level `"token"` field**. A bearer token goes inside `"headers"`.

```ruby
# app/controllers/autonoma_controller.rb
# Session cookie (most web apps)
auth: ->(user, ctx) {
  session = create_session(user["id"])
  { "cookies" => [{ "name" => "session", "value" => session.token, "httpOnly" => true, "sameSite" => "lax", "path" => "/" }] }
}

# JWT bearer token (APIs, SPAs) - the token goes in a header
auth: ->(user, ctx) {
  token = issue_jwt(user["id"])
  { "headers" => { "Authorization" => "Bearer #{token}" } }
}

# Email + password (the runner logs in through the UI, e.g. mobile)
auth: ->(user, ctx) {
  { "credentials" => { "email" => user["email"], "password" => "test-password-123" } }
}
```

For the email/password shape, the `User` factory must create the record with a matching password hash, so a real login succeeds.

## Step 7 - Enable the endpoint

The endpoint returns `404 PRODUCTION_BLOCKED` until `allow_production` is `true`. The SDK never inspects `RAILS_ENV` or any environment variable - this flag is the only switch, so you own the condition:

```ruby
# app/controllers/autonoma_controller.rb
allow_production: true,                          # always on
allow_production: !Rails.env.production?,        # off in prod
```

## Step 8 - Validate before deploying

Dry-run your scenarios against a real (test) database before shipping. Ruby has no `checkScenario` helper; you drive `Autonoma::Handler.handle_request` directly in a test. See `validation.md`. Never ship a scenario you have not validated.

## Step 9 - Smoke-test with curl

The signature is the HMAC-SHA256 hex digest of the raw body, keyed with the shared secret, in the `x-signature` header:

```bash
SECRET="your-shared-secret"
BODY='{"action":"discover"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/.*= //')
curl -s -X POST http://localhost:3000/api/autonoma \
  -H "Content-Type: application/json" -H "x-signature: $SIG" -d "$BODY" | jq .
```

Expected: a JSON schema listing your models and `scopeField`. A `404` means `allow_production` is not set or the route is not mounted; a `401` means the secret does not match.

## Step 10 - Report and connect

Tell the user the endpoint path, confirm all scenarios pass, and hand off:

1. Set `AUTONOMA_SHARED_SECRET` and `AUTONOMA_SIGNING_SECRET` in staging/production env.
2. Deploy the endpoint.
3. Paste `AUTONOMA_SHARED_SECRET` into the Autonoma dashboard when connecting the app.

## Rules

**Do:**
- Reuse the app's existing models and real creation code inside factories.
- Return real credentials from `auth` using the app's own session/JWT logic.
- Register a factory (with a `teardown`) for every model any scenario creates.
- Return string keys and a stringified `"id"` from every `create`.
- Match the project's conventions: file layout, naming, credentials handling.
- Validate every scenario against a real database before deploying.

**Do not:**
- Implement HMAC, token signing, or teardown ordering yourself - the SDK owns all of it.
- Return a hardcoded token like `"test-token"` from `auth`, or a top-level `"token"` key.
- Use the same value for `shared_secret` and `signing_secret`.
- Set `id`, defaulted fields, or auto timestamps in scenario data.
- Expect the SDK to inject the scope field or wire any FK - you set every FK as a `_ref`.
