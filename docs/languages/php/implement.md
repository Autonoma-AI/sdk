# Implement the endpoint (PHP / Laravel)

Follow these steps to stand up a working Environment Factory endpoint. This is written for a coding agent doing the integration; do the steps in order and do not skip the validation step.

## Prerequisites

- PHP 8.2 or newer.
- Composer.
- Your app's real creation code (Eloquent models, service classes, a signup function) - your factories call it.
- Laravel 11+ if you use the bundled server adapter. A non-Laravel app can call the handler directly (see Step 5).

## Step 1 - Install the package

There is one package. It bundles the core handler and the Laravel server adapter; there is no separate server-adapter package and no ORM adapter - the SDK is factory-driven.

```bash
# shell
composer require autonoma-ai/sdk
```

On Laravel the service provider `Autonoma\Sdk\Laravel\AutonomaServiceProvider` is auto-discovered (declared under `extra.laravel.providers` in the package). Publish the config file:

```bash
# shell
php artisan vendor:publish --tag=autonoma-config
```

That writes `config/autonoma.php`.

## Step 2 - Generate the two secrets

```bash
# shell
openssl rand -hex 32   # AUTONOMA_SHARED_SECRET
openssl rand -hex 32   # AUTONOMA_SIGNING_SECRET  (must be different)
```

Add both to `.env` (and placeholders to `.env.example` if it exists). The SDK returns `SAME_SECRETS` (HTTP 500) if they match.

```env
# .env
AUTONOMA_SHARED_SECRET=...    # shared with Autonoma
AUTONOMA_SIGNING_SECRET=...   # private, never shared
```

## Step 3 - Find the scope field

Read the database schema. Find the foreign key that appears on the most models and points at a single root entity - commonly `organizationId`, `orgId`, `tenantId`, or `workspaceId`. That is the scope field. The root model itself (e.g. `Organization`) does not carry it.

Set it as `AUTONOMA_SCOPE_FIELD` in `.env` (the config default is `organizationId`). Confirm the field, the endpoint path, and the app's auth mechanism with the user before writing code.

## Step 4 - Write a factory per model

Write one factory for each model the platform will create, calling your app's real creation code. See `factories.md` for the full contract. Collect them into one associative array keyed by model name:

```php
// app/Autonoma/factories.php
use Autonoma\Sdk\Factory;
use Autonoma\Sdk\Types\FactoryContext;
use App\Models\Organization;

return [
    'Organization' => Factory::define(
        create: fn(array $data, FactoryContext $ctx) => Organization::create($data)->toArray(),
        inputFields: [Factory::field('name', 'string'), Factory::field('slug', 'string')],
        teardown: fn(array $record, FactoryContext $ctx) => Organization::destroy($record['id']),
    ),
    // ... one entry per model
];
```

## Step 5 - Wire the endpoint

### Laravel (config-driven, recommended)

The service provider registers a `POST` route automatically at the configured path and builds the `HandlerConfig` from `config/autonoma.php`. You do not add a route yourself - you fill in the config. Load the factories from Step 4 and set the auth closure:

```php
// config/autonoma.php
return [
    'scope_field'      => env('AUTONOMA_SCOPE_FIELD', 'organizationId'),
    'shared_secret'    => env('AUTONOMA_SHARED_SECRET', ''),
    'signing_secret'   => env('AUTONOMA_SIGNING_SECRET', ''),
    'path'             => env('AUTONOMA_PATH', 'api/autonoma'),
    'middleware'       => [],
    'factories'        => require base_path('app/Autonoma/factories.php'),
    'auth'             => function (?array $user, array $ctx): array {      // see Step 6
        $token = auth()->login(\App\Models\User::find($user['id']));
        return ['headers' => ['Authorization' => "Bearer {$token}"]];
    },
];
```

The default route path is `api/autonoma`; change it with `AUTONOMA_PATH`. Add auth-exempt or throttle middleware via the `middleware` array if needed.

### Plain PHP (no Laravel)

Call the static handler directly. Build a `HandlerConfig`, wrap the raw request as a `HandlerRequest`, and pass both to `Handler::handleRequest`. It returns a `HandlerResponse` with `status` and `body`:

```php
// public/autonoma.php
use Autonoma\Sdk\Handler;
use Autonoma\Sdk\Refs;
use Autonoma\Sdk\Types\FactoryContext;
use Autonoma\Sdk\Types\HandlerConfig;
use Autonoma\Sdk\Types\HandlerRequest;

$config = new HandlerConfig(
    scopeField: 'organizationId',
    sharedSecret: getenv('AUTONOMA_SHARED_SECRET'),
    signingSecret: getenv('AUTONOMA_SIGNING_SECRET'),
    auth: fn(?array $user, array $ctx) => ['headers' => ['Authorization' => 'Bearer ' . issueToken($user['id'])]],
    factories: require __DIR__ . '/../app/Autonoma/factories.php',
);

$req = new HandlerRequest(
    body: file_get_contents('php://input'),
    headers: array_change_key_case(getallheaders(), CASE_LOWER),   // SDK reads 'x-signature'
);

$res = Handler::handleRequest($config, $req);
http_response_code($res->status);
header('Content-Type: application/json');
echo json_encode(Refs::serializeForJson($res->body));
```

Normalize header names to lowercase - the SDK reads the HMAC from the `x-signature` header.

## Step 6 - Implement the auth callback

This is the part that most often breaks tests, so get it right. The callback signature is `function (?array $user, array $ctx): array`. It receives the first created `User` record as an associative array (or `null` if the scenario made none) and `$ctx` with `scope_value` and `refs`. It must return **real, working credentials** using the app's actual auth mechanism. If it returns a fake or hardcoded token, every test fails at login.

The return array is one of `['cookies' => ...]`, `['headers' => ...]`, or `['credentials' => ...]` - there is **no** top-level `token` field. Pick the shape that matches how your app authenticates:

```php
// config/autonoma.php  (auth closure)

// Session cookie (most server-rendered web apps)
'auth' => fn(?array $user, array $ctx) => [
    'cookies' => [
        ['name' => 'session', 'value' => startSession($user['id']), 'httpOnly' => true, 'path' => '/'],
    ],
],

// JWT bearer token (APIs, SPAs) - the token goes in a header
'auth' => fn(?array $user, array $ctx) => [
    'headers' => ['Authorization' => 'Bearer ' . issueJwt($user['id'])],
],

// Email + password (the runner logs in through the UI, e.g. mobile)
'auth' => fn(?array $user, array $ctx) => [
    'credentials' => ['email' => $user['email'], 'password' => 'test-password-123'],
],
```

For the email/password shape, the `User` factory must create the record with a matching password hash, so a real login succeeds. `$ctx['scope_value']` holds the detected scope value (e.g. the organization id) if you need it.

## Step 7 - The endpoint is always enabled

There is no on/off switch: HMAC signing is the gate, so the endpoint serves only requests signed with your shared secret. The old `allowProduction` flag (`allow_production` in `config/autonoma.php`, driven by `AUTONOMA_ALLOW_PRODUCTION`) is deprecated and ignored - the key is still accepted so existing configs keep working. On Autonoma previews (`AUTONOMA_PREVIEWKIT` is set) no guard is needed. If you deploy the factory in your own environments and want it dark in production, gate it manually in your handler, e.g. return `404` before calling `Handler::handleRequest` when `getenv('APP_ENV') === 'production'`.

## Step 8 - Validate before deploying

Dry-run your scenarios against a real database with `Check::checkScenario` and iterate until they pass. See `validation.md`. Never ship a scenario you have not validated.

## Step 9 - Smoke-test with curl

```bash
# shell
SECRET="your-shared-secret"
BODY='{"action":"discover"}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/.*= //')
curl -s -X POST http://localhost:8000/api/autonoma \
  -H "Content-Type: application/json" -H "x-signature: $SIG" -d "$BODY" | jq .
```

Expected: a JSON schema listing your models and `scopeField`. A `404` means the route is not mounted; a `401` means the secret does not match.

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
- Match the project's conventions: namespaces, file layout, naming.
- Validate every scenario with `Check::checkScenario` before deploying.

**Do not:**
- Implement HMAC, token signing, or teardown ordering yourself - the SDK owns all of it.
- Return a hardcoded token like `'test-token'` from `auth`.
- Use the same value for `shared_secret` and `signing_secret`.
- Set `id`, defaulted fields, or auto timestamps in scenario data.
- Expect the SDK to inject the scope field or wire any FK - you set every FK as a `_ref`.
