# Validating scenarios (Ruby)

A scenario's `up`/`down` is ordinary code, and `down` is easy to get subtly wrong, so validate every scenario against a real database before it reaches production. The Ruby SDK ships **no** `check_scenario` helper - you validate by driving `Autonoma::Handler.handle_request(config, req)` through the same full `up` then `down` cycle the platform hits, in a Minitest test. No HTTP server required.

## Signing the request

Every request `handle_request` accepts must carry a valid `x-signature` header: the HMAC-SHA256 of the raw body keyed with the `shared_secret`. Build the `Autonoma::HandlerRequest` with a small helper that signs the body via `Autonoma::Hmac.sign_body(body, shared_secret)`:

```ruby
def signed_request(body, secret)
  body_str = body.is_a?(String) ? body : JSON.generate(body)
  Autonoma::HandlerRequest.new(
    body: body_str,
    headers: { "x-signature" => Autonoma::Hmac.sign_body(body_str, secret) }
  )
end
```

## Driving up then down

`handle_request` returns an `Autonoma::HandlerResponse` with `.status` (Integer) and `.body` (a Hash). Run `up` to get the `teardownToken` off the response, then feed that token straight back into a `down` request.

```ruby
# test/test_scenarios.rb
require "minitest/autorun"
require "json"
require "autonoma"

SHARED  = "shared-secret-for-validation"
SIGNING = "signing-secret-for-validation"   # must differ from SHARED

class TestScenarios < Minitest::Test
  def signed_request(body, secret = SHARED)
    body_str = body.is_a?(String) ? body : JSON.generate(body)
    Autonoma::HandlerRequest.new(
      body: body_str,
      headers: { "x-signature" => Autonoma::Hmac.sign_body(body_str, secret) }
    )
  end

  def config
    @config ||= Autonoma::HandlerConfig.new(
      shared_secret: SHARED,
      signing_secret: SIGNING,
      scenarios: SCENARIOS   # the array you pass to your handler
    )
  end

  SCENARIOS.each do |scenario|
    define_method("test_validates_#{scenario.name}") do
      test_run_id = "check-#{scenario.name}"

      up = { "action" => "up", "scenario" => { "name" => scenario.name }, "testRunId" => test_run_id }
      up_res = Autonoma::Handler.handle_request(config, signed_request(up))
      assert_equal 200, up_res.status, "up failed: #{up_res.body.inspect}"

      down = {
        "action" => "down",
        "teardownToken" => up_res.body["teardownToken"],
        "testRunId" => test_run_id
      }
      down_res = Autonoma::Handler.handle_request(config, signed_request(down))
      assert_equal 200, down_res.status, "down failed: #{down_res.body.inspect}"
      assert_equal true, down_res.body["ok"]
    end
  end
end
```

Because `handle_request` runs the real `up`/`down`, they must point at a real (test) database - use a disposable local database or a Docker Postgres, and reset it between runs.

```bash
rake test                                     # runs test/**/test_*.rb
ruby -Ilib -Itest test/test_scenarios.rb      # a single file
```

## Reading the outcome

Everything you need is on the `HandlerResponse`:

| Signal | Where | Meaning |
|--------|-------|---------|
| `res.status == 200` on `up` | `up_res.status` | provisioning succeeded |
| `res.body["teardownToken"]` | `up_res.body["teardownToken"]` | the signed token you feed into `down` |
| `res.status == 200 && res.body["ok"]` on `down` | `down_res.body` | teardown succeeded |
| `res.body["code"]` on any non-200 | `res.body["code"]` | the error code (`UNKNOWN_ENVIRONMENT`, `INVALID_TEARDOWN_TOKEN`, ...) |

A scenario whose `up` raises returns a 500 with `code == "INTERNAL_ERROR"` and the underlying message in `res.body["error"]`.

## The fix loop

Validation is iterative, especially the first time you write a scenario:

1. Run the test.
2. If it fails, read `res.body["error"]` and `res.body["code"]`, and which phase (`up` vs `down`) the failing request was.
3. Fix the scenario code and re-run.
4. Repeat until both requests return `200`.

Common failures and fixes:

| `res.body["error"]` contains | Cause | Fix |
|------------------------------|-------|-----|
| `Unique constraint ... email` (on `up`, `INTERNAL_ERROR`) | A unique value was not seeded from `test_run_id`, so two runs collide | Derive it with `Autonoma::Unique.unique_email`/`unique_slug`/`unique_id` from `ctx.test_run_id`. |
| a failure on the `down` request | `down` referenced a handle `up` never put in `teardown`, or deleted in the wrong order | Return every id `down` needs from `up` as `teardown`, and delete children before parents. |
| `up` raised before returning | Provisioning code failed (missing required field, bad FK) | Fix the creation call; run the same code path your app uses in production. |
