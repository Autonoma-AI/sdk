# Implement the endpoint (PHP)

Follow these steps to stand up a working Environment Factory endpoint. This is written for a coding agent doing the integration; do the steps in order and do not skip the validation step.

## Prerequisites

- A PHP 8.2+ backend. The shipped server adapter is Laravel; on any other framework you call `Autonoma\Sdk\Handler::handleRequest` yourself from one route.
- A database and the client your app already uses (Eloquent, a query builder, raw PDO - it does not matter; your scenario code calls it).

## Step 1 - Install the package

The Composer package is `autonoma-ai/sdk` (PSR-4 namespace `Autonoma\Sdk\`; types under `Autonoma\Sdk\Types\`, the Laravel adapter under `Autonoma\Sdk\Laravel\`).

```bash
composer require autonoma-ai/sdk
```

On Laravel there is nothing else to install. The `Autonoma\Sdk\Laravel\AutonomaServiceProvider` is auto-discovered (declared in the package's `composer.json` under `extra.laravel.providers`), so it registers the route and the `HandlerConfig` binding automatically. Publish the config file so you have somewhere to register scenarios:

```bash
php artisan vendor:publish --tag=autonoma-config
```

This writes `config/autonoma.php`. On a non-Laravel framework there is no config file to publish - skip to building `HandlerConfig` by hand in Step 5.

## Step 2 - Generate the two secrets

```bash
openssl rand -hex 32   # AUTONOMA_SHARED_SECRET
openssl rand -hex 32   # AUTONOMA_SIGNING_SECRET  (must be different)
```

Add both to `.env` (and placeholders to `.env.example` if it exists). The SDK returns `SAME_SECRETS` at startup if they match.

```env
# .env
AUTONOMA_SHARED_SECRET=...   # shared with Autonoma
AUTONOMA_SIGNING_SECRET=...  # private, never shared
```

The published `config/autonoma.php` reads these from `env('AUTONOMA_SHARED_SECRET')` and `env('AUTONOMA_SIGNING_SECRET')` into the `shared_secret` / `signing_secret` keys.

## Step 3 - Confirm the endpoint path and auth mechanism

There is no scope field to find in v2. Instead, confirm two things with the user before writing code:

- The endpoint path you will mount. On Laravel this is the `path` key in `config/autonoma.php` (env `AUTONOMA_PATH`), default `'api/autonoma'`.
- How the app authenticates a request (session cookie, JWT bearer, or email + password), so your scenarios' `up` can return real, working credentials.

## Step 4 - Write scenarios

A scenario is named code that provisions an environment. Author each with `Autonoma\Sdk\Scenario::defineScenario` using named arguments: a `name`, a `description`, an `up` closure, and an optional `down` closure. `up` runs whatever provisioning code you would write by hand and returns a `ScenarioUpResult` (or a plain associative array with `'auth'` / `'teardown'` keys). See `scenarios.md` for the authoring rules.

```php
use Autonoma\Sdk\Scenario;
use Autonoma\Sdk\Unique;
use Autonoma\Sdk\Types\ScenarioUpContext;
use Autonoma\Sdk\Types\ScenarioUpResult;
use Autonoma\Sdk\Types\ScenarioDownContext;

Scenario::defineScenario(
    name: 'single-user',
    description: 'One verified user in a fresh org',
    up: function (ScenarioUpContext $ctx): ScenarioUpResult {
        $email = Unique::uniqueEmail($ctx->testRunId);
        $user = User::create(['email' => $email]);
        return new ScenarioUpResult(
            auth: ['headers' => ['Authorization' => "Bearer {$user->token}"]],
            teardown: ['userId' => $user->id],
        );
    },
    down: fn(ScenarioDownContext $ctx) => User::destroy($ctx->teardown['userId']),
);
```

- `up` receives a `ScenarioUpContext`; its one field is `$ctx->testRunId`.
- `down` receives a `ScenarioDownContext` with `$ctx->name`, `$ctx->teardown` (the array your `up` returned), and `$ctx->testRunId`. It returns nothing.

## Step 5 - Register the scenarios

On Laravel you do not call a handler factory - the auto-discovered provider mounts the route and builds `HandlerConfig` from `config/autonoma.php`. Wiring means listing your scenarios in that file's `scenarios` array:

```php
// config/autonoma.php
<?php

use Autonoma\Sdk\Scenario;
use Autonoma\Sdk\Unique;
use Autonoma\Sdk\Types\ScenarioUpContext;
use Autonoma\Sdk\Types\ScenarioUpResult;
use Autonoma\Sdk\Types\ScenarioDownContext;
use App\Models\User;

return [
    'shared_secret'  => env('AUTONOMA_SHARED_SECRET', ''),
    'signing_secret' => env('AUTONOMA_SIGNING_SECRET', ''),
    'path'           => env('AUTONOMA_PATH', 'api/autonoma'),
    'middleware'     => [],
    'scenarios'      => [
        Scenario::defineScenario(
            name: 'single-user',
            description: 'One verified user in a fresh org',
            up: function (ScenarioUpContext $ctx): ScenarioUpResult {
                $email = Unique::uniqueEmail($ctx->testRunId);
                $user = User::create(['email' => $email]);
                return new ScenarioUpResult(
                    auth: ['headers' => ['Authorization' => "Bearer {$user->token}"]],
                    teardown: ['userId' => $user->id],
                );
            },
            down: fn(ScenarioDownContext $ctx) => User::destroy($ctx->teardown['userId']),
        ),
        // standard, large, ...
    ],
];
```

The config keys the provider reads are `shared_secret`, `signing_secret`, `scenarios`, `expires_in_seconds` (optional; env `AUTONOMA_EXPIRES_IN_SECONDS`, default one hour when null), `path`, and `middleware`. There is no `scopeField`, no `factories` registry, and no top-level `auth` callback - auth is returned per-scenario from `up`.

On any non-Laravel framework, build the config yourself and call the static handler from one POST route. `HandlerConfig` and `Handler::handleRequest` take named arguments; `HandlerRequest` carries the raw body string and headers:

```php
use Autonoma\Sdk\Handler;
use Autonoma\Sdk\Types\HandlerConfig;
use Autonoma\Sdk\Types\HandlerRequest;

$config = new HandlerConfig(
    sharedSecret: getenv('AUTONOMA_SHARED_SECRET'),
    signingSecret: getenv('AUTONOMA_SIGNING_SECRET'),
    scenarios: [/* Scenario::defineScenario(...) */],
);

// inside your route handler
$response = Handler::handleRequest($config, new HandlerRequest(
    body: file_get_contents('php://input'),   // the untouched raw body
    headers: ['x-signature' => $_SERVER['HTTP_X_SIGNATURE'] ?? ''],
));
// $response->status (int) and $response->body (array) -> emit as JSON
```

`Handler::handleRequest(HandlerConfig $config, HandlerRequest $req): HandlerResponse` is static. It must see the exact raw request bytes so the HMAC over the body matches; read the body before any middleware reparses it.

## Step 6 - Return real credentials from `up`

The `auth` a scenario's `up` returns is the part that most often breaks tests, so get it right. It must be **real, working credentials** produced by the app's actual auth mechanism. A fake or hardcoded token makes every test fail at login. `auth` is an associative array; the convention is one of `headers`, `cookies`, or `credentials`. There is no top-level `token` key.

```php
// JWT / bearer token (APIs, SPAs) - the token goes in a header
return new ScenarioUpResult(
    auth: ['headers' => ['Authorization' => "Bearer {$token}"]],
    teardown: ['userId' => $user->id],
);

// Session cookie (most server-rendered web apps)
return new ScenarioUpResult(
    auth: ['cookies' => [['name' => 'session', 'value' => $session->token, 'path' => '/']]],
    // ...
);

// Email + password (the runner logs in through the UI, e.g. mobile)
return new ScenarioUpResult(
    auth: ['credentials' => ['email' => $user->email, 'password' => 'test-password-123']],
    // ...
);
```

For the email/password shape, the scenario must create the user with a matching password hash so a real login succeeds.

## Step 7 - Production gating (optional)

The endpoint is always enabled - HMAC signing is the gate, and unsigned requests get `401`. The old `allow_production` flag (`allowProduction` on `HandlerConfig`) is deprecated and ignored. On Autonoma preview environments (`AUTONOMA_PREVIEWKIT` is set) nothing more is needed - previews are isolated and never production. If you deploy the factory in your own environments and want it dark in production anyway, gate the route with your own condition - for example, register it only outside production:

```php
// routes or a service provider
if (! app()->environment('production')) {
    // let the Autonoma route stand; otherwise never register/serve it
}
```

Or attach middleware that returns `404` in production via the config `middleware` key.

## Step 8 - Validate before deploying

PHP ships no `checkScenario` helper. Validate by driving `Handler::handleRequest` through a full `up` then `down` cycle against a real (test) database in a PHPUnit test, signing the body yourself with `Autonoma\Sdk\Hmac::signBody`. See `validation.md`. Never ship a scenario you have not validated.

## Step 9 - Smoke-test with curl

```bash
SECRET="your-shared-secret"
BODY='{"action":"discover"}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/.*= //')
curl -s -X POST http://localhost:8000/api/autonoma \
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
- Reuse the app's existing DB client and real creation code inside `up` (Eloquent models, your service layer).
- Return real credentials from `auth` using the app's own session/JWT logic.
- Seed every unique value from `testRunId` with the `Unique::unique*` helpers.
- Match the project's conventions: namespaces, file layout, naming.
- Validate every scenario through a full `up` + `down` cycle before deploying.

**Do not:**
- Implement HMAC, token signing, or expiry yourself - the SDK owns all of it.
- Return a hardcoded token like `"test-token"` from `auth`.
- Use the same value for `shared_secret` and `signing_secret`.
- Reach for `random_bytes`, `uniqid`, or `time()` for a unique value - it breaks the determinism `down` and debugging rely on.
