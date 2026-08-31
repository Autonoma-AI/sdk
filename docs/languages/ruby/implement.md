# Implement the endpoint (Ruby)

Follow these steps to stand up a working Environment Factory endpoint. This is written for a coding agent doing the integration; do the steps in order and do not skip the validation step.

## Prerequisites

- A Ruby backend on Ruby 3.1+ (Rails, a Rack app, or anything that can hand you the raw request body).
- The database client or service layer your app already uses (ActiveRecord, Sequel, raw `pg` - it does not matter; your scenario code calls it).

## Step 1 - Install the gem and pick the adapter

The gem is `autonoma-ai`. It has no hard runtime dependencies - the core uses only stdlib (`openssl`, `json`, `base64`, `securerandom`).

```ruby
# Gemfile
gem "autonoma-ai"
```

```bash
bundle install   # or: gem install autonoma-ai
```

The core lives under `require "autonoma"` (module `Autonoma`). The server adapter for Rails and Rack lives under `require "autonoma_rails/server"` (module `AutonomaRails`):

| Framework | How you mount it |
|-----------|------------------|
| Rails | `include AutonomaRails::Handler` in a controller, then `autonoma_handle(config)` in an action |
| Rack (Sinatra, plain Rack, ...) | `use AutonomaRails::Middleware, config, path: "/api/autonoma"` |
| Anything else | Call `Autonoma::Handler.handle_request(config, req)` directly with an `Autonoma::HandlerRequest` you build from the raw body + headers |

There is no ORM adapter to install - scenarios call your app's own code directly.

## Step 2 - Generate the two secrets

```bash
openssl rand -hex 32   # AUTONOMA_SHARED_SECRET
openssl rand -hex 32   # AUTONOMA_SIGNING_SECRET  (must be different)
```

Add both to your environment (and placeholders to `.env.example` if you keep one). `Autonoma::Handler.handle_request` raises `SAME_SECRETS` (HTTP 500) if the two values are equal.

```env
AUTONOMA_SHARED_SECRET=...   # shared with Autonoma
AUTONOMA_SIGNING_SECRET=...  # private, never shared
```

## Step 3 - Confirm the endpoint path and auth mechanism

There is no scope field to find in v2. Instead, confirm two things with the user before writing code:

- The endpoint path you will mount (for example `/api/autonoma`).
- How the app authenticates a request (session cookie, JWT bearer, or email + password), so your scenarios' `up` can return real, working credentials.

## Step 4 - Write scenarios

A scenario is named code that provisions an environment. Author each with `Autonoma::Scenario.define_scenario`: a `name:`, a `description:`, an `up:`, and an optional `down:`. `up` is a lambda/proc (or a passed block) that receives a `ScenarioUpContext` (one reader, `ctx.test_run_id`) and returns a Hash with `:auth` / `:teardown` keys (all optional; a `ScenarioUpResult` struct works too). `down` receives a `ScenarioDownContext` (`ctx.name`, `ctx.teardown`, `ctx.test_run_id`). See `scenarios.md` for the authoring rules.

```ruby
# app/autonoma/scenarios.rb
module Scenarios
  SINGLE_USER = Autonoma::Scenario.define_scenario(
    name: "single-user",
    description: "One verified user in a fresh org",
    up: ->(ctx) {
      email = Autonoma::Unique.unique_email(ctx.test_run_id)
      user = App::User.create!(email: email)
      {
        auth: { "headers" => { "Authorization" => "Bearer #{user.token}" } },
        teardown: { "userId" => user.id }
      }
    },
    down: ->(ctx) { App::User.delete(ctx.teardown["userId"]) }
  )
end
```

Collect them into one array to pass to the config:

```ruby
SCENARIOS = [Scenarios::SINGLE_USER, Scenarios::STANDARD, Scenarios::LARGE]
```

## Step 5 - Wire the handler

Build the config once with `Autonoma::HandlerConfig.new`. It carries the two secrets and the scenario array (plus optional `expires_in_seconds:` and `sdk:`). There is no `scope_field`, no `factories`, and no top-level `auth` callback.

```ruby
config = Autonoma::HandlerConfig.new(
  shared_secret: ENV["AUTONOMA_SHARED_SECRET"],
  signing_secret: ENV["AUTONOMA_SIGNING_SECRET"],
  scenarios: SCENARIOS
)
```

**Rails** - mix the handler into a controller and skip CSRF (the request is authenticated by HMAC, not a Rails session):

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
      shared_secret: ENV["AUTONOMA_SHARED_SECRET"],
      signing_secret: ENV["AUTONOMA_SIGNING_SECRET"],
      scenarios: SCENARIOS
    )
  end
end
```

```ruby
# config/routes.rb
post "/api/autonoma", to: "autonoma#handle"
```

`autonoma_handle` reads `request.raw_post` (the untouched body the HMAC is computed over), verifies it, routes the action, and renders the JSON response with the right status.

**Rack** - mount the middleware; it only intercepts `POST` to `path:`:

```ruby
# config.ru
require "autonoma_rails/server"

use AutonomaRails::Middleware, config, path: "/api/autonoma"
run YourApp
```

Both adapters stamp `sdk.server = "rails"` on the response metadata. For any other host, call the core directly (see Step 8 for the request shape).

## Step 6 - Return real credentials from `up`

The `auth` a scenario's `up` returns is the part that most often breaks tests, so get it right. It must be **real, working credentials** produced by the app's actual auth mechanism. A fake or hardcoded token makes every test fail at login. `auth` is a plain Hash with the conventional string keys `"cookies"` / `"headers"` / `"credentials"` - there is no top-level `"token"` field.

```ruby
# JWT bearer token (APIs, SPAs) - the token goes in a header
{ auth: { "headers" => { "Authorization" => "Bearer #{token}" } } }

# Session cookie (most web apps)
{ auth: { "cookies" => [{ "name" => "session", "value" => session.token,
                          "httpOnly" => true, "sameSite" => "lax", "path" => "/" }] } }

# Email + password (the runner logs in through the UI, e.g. mobile)
{ auth: { "credentials" => { "email" => user.email, "password" => "test-password-123" } } }
```

For the email/password shape, the scenario must create the user with a matching password hash so a real login succeeds.

## Step 7 - Production gating (optional)

The endpoint is always enabled - HMAC signing is the gate, and unsigned requests get `401`. The old `allow_production:` keyword is deprecated and ignored (passing `true` only prints a deprecation warning). On Autonoma preview environments (`AUTONOMA_PREVIEWKIT` is set) nothing more is needed - previews are isolated and never production. If you deploy the factory in your own environments and want it dark in production anyway, gate it in your controller/route with your own condition:

```ruby
def handle
  return head :not_found if Rails.env.production?
  autonoma_handle(autonoma_config)
end
```

## Step 8 - Validate before deploying

Ruby has no `check_scenario` helper. Validate by driving `Autonoma::Handler.handle_request(config, req)` through a full `up` then `down` cycle against a real (test) database in a Minitest test, asserting each response status and body. See `validation.md`. Never ship a scenario you have not validated.

## Step 9 - Smoke-test with curl

```bash
SECRET="your-shared-secret"
BODY='{"action":"discover"}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/.*= //')
curl -s -X POST http://localhost:3000/api/autonoma \
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
- Reuse the app's existing DB client and real creation code inside `up`.
- Return real credentials from `auth` using the app's own session/JWT logic.
- Seed every unique value from `ctx.test_run_id` with the `Autonoma::Unique.unique_*` helpers.
- Match the project's conventions: require style, file layout, naming.
- Validate every scenario through `handle_request` before deploying.

**Do not:**
- Implement HMAC, token signing, or expiry yourself - the SDK owns all of it.
- Return a hardcoded token like `"test-token"` from `auth`.
- Use the same value for `shared_secret:` and `signing_secret:`.
- Reach for `SecureRandom.uuid` or `Time.now` for a unique value - it breaks the determinism `down` and debugging rely on.
