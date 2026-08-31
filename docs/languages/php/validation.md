# Validating scenarios (PHP)

A scenario's `up`/`down` is ordinary code, but `down` is easy to get subtly wrong, so validate every scenario against a real database before it reaches production. The PHP SDK ships no `checkScenario` helper. You validate the way the platform does: drive `Autonoma\Sdk\Handler::handleRequest` through a full `up` then `down` cycle in a PHPUnit test, signing each request body yourself. This runs the exact same code path the platform hits, with no HTTP server required.

## Sign the request, then call the handler

Every request the handler accepts carries an `x-signature` header: the HMAC-SHA256 of the raw body, keyed with the shared secret. Produce it with `Autonoma\Sdk\Hmac::signBody($body, $sharedSecret)` and put it on the `HandlerRequest`.

```php
use Autonoma\Sdk\Handler;
use Autonoma\Sdk\Hmac;
use Autonoma\Sdk\Types\HandlerConfig;
use Autonoma\Sdk\Types\HandlerRequest;

function callHandler(HandlerConfig $config, array $payload, string $shared): array
{
    $body = json_encode($payload);
    $req = new HandlerRequest(
        body: $body,
        headers: ['x-signature' => Hmac::signBody($body, $shared)],
    );
    $res = Handler::handleRequest($config, $req);
    return ['status' => $res->status, 'body' => $res->body];
}
```

## A full up + down PHPUnit test

Build a `HandlerConfig` with two distinct test secrets and your scenario array (import it from wherever your app registers scenarios). Run `up`, then feed the returned `teardownToken` straight into `down`.

```php
use Autonoma\Sdk\Scenario;
use Autonoma\Sdk\Unique;
use Autonoma\Sdk\Types\HandlerConfig;
use Autonoma\Sdk\Types\ScenarioUpContext;
use Autonoma\Sdk\Types\ScenarioUpResult;
use Autonoma\Sdk\Types\ScenarioDownContext;
use PHPUnit\Framework\TestCase;

final class ScenarioValidationTest extends TestCase
{
    private const SHARED  = 'check-shared-secret';
    private const SIGNING = 'check-signing-secret';   // must differ from SHARED

    private function config(): HandlerConfig
    {
        return new HandlerConfig(
            sharedSecret: self::SHARED,
            signingSecret: self::SIGNING,
            scenarios: [
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
            ],
        );
    }

    public function testSingleUserUpAndDown(): void
    {
        $config = $this->config();

        $up = callHandler($config, [
            'action'    => 'up',
            'scenario'  => ['name' => 'single-user'],
            'testRunId' => 'test-run-1',
        ], self::SHARED);

        $this->assertSame(200, $up['status']);
        $this->assertArrayHasKey('teardownToken', $up['body']);

        $down = callHandler($config, [
            'action'        => 'down',
            'teardownToken' => $up['body']['teardownToken'],
            'testRunId'     => 'test-run-1',
        ], self::SHARED);

        $this->assertSame(200, $down['status']);
        $this->assertTrue($down['body']['ok']);
    }
}
```

```bash
composer install && ./vendor/bin/phpunit
# a single file:
./vendor/bin/phpunit tests/ScenarioValidationTest.php
```

Because `up`/`down` run your real creation and deletion code, point the app at a real (test) database first. In Laravel, extend `Orchestra\Testbench\TestCase` (or your app's base test case) and run migrations against a disposable database - a SQLite `:memory:` connection or a throwaway Postgres - in `setUp`, so each `up`/`down` cycle hits a real schema.

## Reading a failure

`Handler::handleRequest` never throws for a scenario failure; it returns a `HandlerResponse` whose `status` and `body` carry the error. Assert on those.

- A scenario whose `up` throws comes back as `status: 500`, `body: { error, code: 'INTERNAL_ERROR' }` - the `error` message is the underlying database or app exception.
- A teardown that throws surfaces the same way on the `down` call.

## The fix loop

Validation is iterative, especially the first time you write a scenario:

1. Run the test.
2. If it fails, read the response `body['error']` and `body['code']`.
3. Fix the scenario code and re-run.
4. Repeat until `up` returns `200` and `down` returns `200` with `ok: true`.

Common failures and fixes:

| Message / code contains | Cause | Fix |
|-------------------------|-------|-----|
| `Unique constraint failed ... email` (`INTERNAL_ERROR`) | A unique value was not seeded from `testRunId`, so two runs collide | Derive it with `Unique::uniqueEmail` / `Unique::uniqueSlug` / `Unique::uniqueId` from `$ctx->testRunId`. |
| an error on the `down` call | `down` referenced a handle `up` never put in `teardown`, or deleted in the wrong order | Return every id `down` needs from `up` as `teardown`, and delete children before parents. |
| `up` failed before returning (`INTERNAL_ERROR`) | Provisioning code failed (missing required field, bad FK) | Fix the creation call; run the same code path your app uses in production. |
