<?php

namespace Autonoma\Sdk\Tests;

use Autonoma\Sdk\Handler;
use Autonoma\Sdk\Hmac;
use Autonoma\Sdk\Scenario;
use Autonoma\Sdk\Types\HandlerConfig;
use Autonoma\Sdk\Types\HandlerRequest;
use Autonoma\Sdk\Types\ScenarioDefinition;
use Autonoma\Sdk\Types\ScenarioDownContext;
use Autonoma\Sdk\Types\ScenarioUpContext;
use Autonoma\Sdk\Types\ScenarioUpResult;
use PHPUnit\Framework\TestCase;

class HandlerTest extends TestCase
{
    private function standardScenario(?callable $down = null): ScenarioDefinition
    {
        return Scenario::defineScenario(
            name: 'standard',
            description: 'A standard seeded environment',
            up: fn(ScenarioUpContext $ctx) => new ScenarioUpResult(
                auth: ['headers' => ['Authorization' => 'Bearer ' . $ctx->testRunId]],
                teardown: ['userId' => 'user-' . $ctx->testRunId],
            ),
            down: $down,
        );
    }

    private function emptyScenario(): ScenarioDefinition
    {
        return Scenario::defineScenario(
            name: 'empty',
            description: 'Nothing seeded',
            up: fn(ScenarioUpContext $ctx) => new ScenarioUpResult(),
        );
    }

    /** @param ScenarioDefinition[]|null $scenarios */
    private function makeConfig(?array $scenarios = null): HandlerConfig
    {
        return new HandlerConfig(
            sharedSecret: 'shared',
            signingSecret: 'signing',
            scenarios: $scenarios ?? [$this->standardScenario(), $this->emptyScenario()],
        );
    }

    private function makeRequest(string $body, string $secret = 'shared'): HandlerRequest
    {
        return new HandlerRequest(
            body: $body,
            headers: ['x-signature' => Hmac::signBody($body, $secret)],
        );
    }

    // --- request gate ---

    public function testRejectsInvalidSignature(): void
    {
        $req = new HandlerRequest(body: '{"action":"discover"}', headers: ['x-signature' => 'invalid']);
        $res = Handler::handleRequest($this->makeConfig(), $req);
        $this->assertSame(401, $res->status);
        $this->assertSame('INVALID_SIGNATURE', $res->body['code']);
    }

    public function testRejectsSameSecrets(): void
    {
        $config = new HandlerConfig(sharedSecret: 'same', signingSecret: 'same');
        $res = Handler::handleRequest($config, $this->makeRequest('{"action":"discover"}', 'same'));
        $this->assertSame(500, $res->status);
        $this->assertSame('SAME_SECRETS', $res->body['code']);
    }

    public function testRejectsInvalidJson(): void
    {
        $res = Handler::handleRequest($this->makeConfig(), $this->makeRequest('not json'));
        $this->assertSame(400, $res->status);
        $this->assertSame('INVALID_BODY', $res->body['code']);
    }

    public function testRejectsMissingAction(): void
    {
        $res = Handler::handleRequest($this->makeConfig(), $this->makeRequest('{}'));
        $this->assertSame(400, $res->status);
        $this->assertSame('INVALID_BODY', $res->body['code']);
    }

    public function testRejectsUnknownAction(): void
    {
        $res = Handler::handleRequest($this->makeConfig(), $this->makeRequest('{"action":"nonexistent"}'));
        $this->assertSame(400, $res->status);
        $this->assertSame('UNKNOWN_ACTION', $res->body['code']);
    }

    // --- discover ---

    public function testDiscoverListsScenarios(): void
    {
        $res = Handler::handleRequest($this->makeConfig(), $this->makeRequest('{"action":"discover"}'));
        $this->assertSame(200, $res->status);
        $this->assertSame('2.0', $res->body['version']);
        $this->assertCount(2, $res->body['scenarios']);
        $this->assertSame('standard', $res->body['scenarios'][0]['name']);
        $this->assertNotEmpty($res->body['scenarios'][0]['description']);
        // discover must never leak a create/schema shape in v2.
        $this->assertArrayNotHasKey('schema', $res->body);
    }

    // --- up ---

    public function testUpReturnsEnvelope(): void
    {
        $body = json_encode(['action' => 'up', 'scenario' => ['name' => 'standard'], 'testRunId' => 'run-1']);
        $res = Handler::handleRequest($this->makeConfig(), $this->makeRequest($body));

        $this->assertSame(200, $res->status);
        $this->assertSame('2.0', $res->body['version']);
        $this->assertCount(3, explode('.', $res->body['teardownToken']));
        $this->assertSame(3600, $res->body['expiresInSeconds']);
        // The duplicated plaintext refs and the old refsToken field are gone.
        $this->assertArrayNotHasKey('refs', $res->body);
        $this->assertArrayNotHasKey('refsToken', $res->body);
        $this->assertSame('Bearer run-1', $res->body['auth']['headers']['Authorization']);
    }

    public function testUpCustomExpires(): void
    {
        $config = new HandlerConfig(
            sharedSecret: 'shared',
            signingSecret: 'signing',
            scenarios: [$this->standardScenario(), $this->emptyScenario()],
            expiresInSeconds: 60,
        );
        $body = json_encode(['action' => 'up', 'scenario' => ['name' => 'empty'], 'testRunId' => 'r']);
        $res = Handler::handleRequest($config, $this->makeRequest($body));

        $this->assertSame(60, $res->body['expiresInSeconds']);
        // The empty scenario returns nothing, so no auth on the envelope.
        $this->assertArrayNotHasKey('auth', $res->body);
    }

    public function testUpUnknownEnvironment(): void
    {
        $body = json_encode(['action' => 'up', 'scenario' => ['name' => 'does-not-exist'], 'testRunId' => 'r']);
        $res = Handler::handleRequest($this->makeConfig(), $this->makeRequest($body));
        $this->assertSame(400, $res->status);
        $this->assertSame('UNKNOWN_ENVIRONMENT', $res->body['code']);
    }

    public function testUpMissingScenarioName(): void
    {
        $body = json_encode(['action' => 'up', 'testRunId' => 'r']);
        $res = Handler::handleRequest($this->makeConfig(), $this->makeRequest($body));
        $this->assertSame(400, $res->status);
        $this->assertSame('INVALID_BODY', $res->body['code']);
    }

    public function testUpAcceptsPlainArrayResult(): void
    {
        $arrayScenario = Scenario::defineScenario(
            name: 'plain',
            description: 'up returns a plain array',
            up: fn(ScenarioUpContext $ctx) => [
                'auth' => ['headers' => ['X-Token' => 'plain']],
            ],
        );
        $body = json_encode(['action' => 'up', 'scenario' => ['name' => 'plain'], 'testRunId' => 'r']);
        $res = Handler::handleRequest($this->makeConfig([$arrayScenario]), $this->makeRequest($body));
        $this->assertSame(200, $res->status);
        $this->assertSame('plain', $res->body['auth']['headers']['X-Token']);
    }

    // --- down ---

    public function testDownValidToken(): void
    {
        $downCalls = [];
        $down = function (ScenarioDownContext $ctx) use (&$downCalls): void {
            $downCalls[] = $ctx->name . ':' . $ctx->testRunId;
        };
        $config = $this->makeConfig([$this->standardScenario($down), $this->emptyScenario()]);

        $upBody = json_encode(['action' => 'up', 'scenario' => ['name' => 'standard'], 'testRunId' => 'run-td']);
        $upRes = Handler::handleRequest($config, $this->makeRequest($upBody));
        $token = $upRes->body['teardownToken'];

        $downBody = json_encode(['action' => 'down', 'teardownToken' => $token, 'testRunId' => 'run-td']);
        $downRes = Handler::handleRequest($config, $this->makeRequest($downBody));

        $this->assertSame(200, $downRes->status);
        $this->assertTrue($downRes->body['ok']);
        $this->assertSame(['standard:run-td'], $downCalls);
    }

    public function testDownRoutesByTokenEnvironment(): void
    {
        $downCalls = [];
        $down = function (ScenarioDownContext $ctx) use (&$downCalls): void {
            $downCalls[] = $ctx->name . ':' . $ctx->testRunId;
        };
        $config = $this->makeConfig([$this->standardScenario($down), $this->emptyScenario()]);

        $upBody = json_encode(['action' => 'up', 'scenario' => ['name' => 'standard'], 'testRunId' => 'run-tok']);
        $token = Handler::handleRequest($config, $this->makeRequest($upBody))->body['teardownToken'];

        // No scenario.name on the down request - the handler must recover it from
        // the verified token's environment.
        $downBody = json_encode(['action' => 'down', 'teardownToken' => $token]);
        $downRes = Handler::handleRequest($config, $this->makeRequest($downBody));

        $this->assertSame(200, $downRes->status);
        $this->assertSame(['standard:run-tok'], $downCalls);
    }

    public function testDownInvalidTeardownToken(): void
    {
        $body = json_encode(['action' => 'down', 'teardownToken' => 'tampered.token.value']);
        $res = Handler::handleRequest($this->makeConfig(), $this->makeRequest($body));
        $this->assertSame(403, $res->status);
        $this->assertSame('INVALID_TEARDOWN_TOKEN', $res->body['code']);
    }

    public function testDownMissingTeardownToken(): void
    {
        $res = Handler::handleRequest($this->makeConfig(), $this->makeRequest('{"action":"down"}'));
        $this->assertSame(400, $res->status);
        $this->assertSame('INVALID_BODY', $res->body['code']);
    }

    public function testEndpointAlwaysEnabled(): void
    {
        // allowProduction is a deprecated no-op: discover serves regardless.
        $config = new HandlerConfig(
            sharedSecret: 'shared',
            signingSecret: 'signing',
            scenarios: [$this->standardScenario()],
            allowProduction: false,
        );
        $res = Handler::handleRequest($config, $this->makeRequest('{"action":"discover"}'));
        $this->assertSame(200, $res->status);
    }
}
