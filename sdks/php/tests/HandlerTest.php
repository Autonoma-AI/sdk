<?php

namespace Autonoma\Sdk\Tests;

use Autonoma\Sdk\Factory;
use Autonoma\Sdk\Handler;
use Autonoma\Sdk\Hmac;
use Autonoma\Sdk\Refs;
use Autonoma\Sdk\Types\FactoryContext;
use Autonoma\Sdk\Types\FieldInfo;
use Autonoma\Sdk\Types\HandlerConfig;
use Autonoma\Sdk\Types\HandlerRequest;
use PHPUnit\Framework\TestCase;

class HandlerTest extends TestCase
{
    private function makeConfig(array $factories = []): HandlerConfig
    {
        return new HandlerConfig(
            scopeField: 'organizationId',
            sharedSecret: 'test-shared-secret',
            signingSecret: 'test-signing-secret',
            auth: fn($user, $ctx) => ['credentials' => ['token' => 'test-token']],
            factories: $factories,
        );
    }

    private function makeRequest(string $body, string $secret = 'test-shared-secret'): HandlerRequest
    {
        return new HandlerRequest(
            body: $body,
            headers: ['x-signature' => Hmac::signBody($body, $secret)],
        );
    }

    private function orgFactory(?callable $teardown = null): \Autonoma\Sdk\Types\FactoryDefinition
    {
        return Factory::define(
            create: fn(array $data, FactoryContext $ctx) => ['id' => 'org-' . ($data['name'] ?? 'x'), 'name' => $data['name'] ?? ''],
            inputFields: [new FieldInfo('name', 'string', true)],
            teardown: $teardown,
        );
    }

    private function userFactory(?callable $create = null): \Autonoma\Sdk\Types\FactoryDefinition
    {
        return Factory::define(
            create: $create ?? fn(array $data, FactoryContext $ctx) => [
                'id' => 'user-1',
                'email' => $data['email'] ?? '',
                'name' => $data['name'] ?? '',
                'organizationId' => $data['organization_id'] ?? null,
            ],
            inputFields: [
                new FieldInfo('email', 'string', true),
                new FieldInfo('name', 'string', true),
                new FieldInfo('organization_id', 'string', true),
            ],
        );
    }

    public function testRejectsInvalidSignature(): void
    {
        $config = $this->makeConfig();
        $req = new HandlerRequest(
            body: '{"action":"discover"}',
            headers: ['x-signature' => 'invalid'],
        );
        $res = Handler::handleRequest($config, $req);
        $this->assertSame(401, $res->status);
        $this->assertSame('INVALID_SIGNATURE', $res->body['code']);
    }

    public function testRejectsInvalidJson(): void
    {
        $config = $this->makeConfig();
        $body = 'not json';
        $req = $this->makeRequest($body);
        $res = Handler::handleRequest($config, $req);
        $this->assertSame(400, $res->status);
        $this->assertSame('INVALID_BODY', $res->body['code']);
    }

    public function testRejectsMissingAction(): void
    {
        $config = $this->makeConfig();
        $body = '{}';
        $req = $this->makeRequest($body);
        $res = Handler::handleRequest($config, $req);
        $this->assertSame(400, $res->status);
        $this->assertSame('INVALID_BODY', $res->body['code']);
    }

    public function testRejectsUnknownAction(): void
    {
        $config = $this->makeConfig();
        $body = '{"action":"unknown"}';
        $req = $this->makeRequest($body);
        $res = Handler::handleRequest($config, $req);
        $this->assertSame(400, $res->status);
        $this->assertSame('UNKNOWN_ACTION', $res->body['code']);
    }

    public function testRejectsSameSecrets(): void
    {
        $config = new HandlerConfig(
            scopeField: 'organizationId',
            sharedSecret: 'same-secret',
            signingSecret: 'same-secret',
            auth: fn($user, $ctx) => ['credentials' => ['token' => 'test-token']],
        );
        $body = '{"action":"discover"}';
        $req = new HandlerRequest(
            body: $body,
            headers: ['x-signature' => Hmac::signBody($body, 'same-secret')],
        );
        $res = Handler::handleRequest($config, $req);
        $this->assertSame(500, $res->status);
        $this->assertSame('SAME_SECRETS', $res->body['code']);
    }

    public function testRejectsMissingRefsTokenOnDown(): void
    {
        $config = $this->makeConfig();
        $body = '{"action":"down"}';
        $req = $this->makeRequest($body);
        $res = Handler::handleRequest($config, $req);
        $this->assertSame(400, $res->status);
        $this->assertSame('INVALID_BODY', $res->body['code']);
    }

    public function testRejectsInvalidRefsToken(): void
    {
        $config = $this->makeConfig();
        $body = '{"action":"down","refsToken":"bad.token.here"}';
        $req = $this->makeRequest($body);
        $res = Handler::handleRequest($config, $req);
        $this->assertSame(403, $res->status);
        $this->assertSame('INVALID_REFS_TOKEN', $res->body['code']);
    }

    public function testRejectsMissingCreateOnUp(): void
    {
        $config = $this->makeConfig();
        $body = '{"action":"up"}';
        $req = $this->makeRequest($body);
        $res = Handler::handleRequest($config, $req);
        $this->assertSame(400, $res->status);
        $this->assertSame('INVALID_BODY', $res->body['code']);
    }

    public function testAfterUpHookModifiesAuth(): void
    {
        $config = new HandlerConfig(
            scopeField: 'organizationId',
            sharedSecret: 'test-shared-secret',
            signingSecret: 'test-signing-secret',
            auth: fn($user) => ['credentials' => ['token' => 'test-token']],
            factories: ['Organization' => $this->orgFactory()],
            afterUp: function (array $hookCtx, array $auth): array {
                $auth['headers'] = ['X-Custom' => 'enriched'];
                return $auth;
            },
        );

        $body = json_encode([
            'action' => 'up',
            'create' => ['Organization' => [['name' => 'Org', '_alias' => 'org1']]],
            'testRunId' => 'run-123',
        ]);
        $req = $this->makeRequest($body);
        $res = Handler::handleRequest($config, $req);

        $this->assertSame(200, $res->status);
        $this->assertArrayHasKey('auth', $res->body);
        $this->assertSame('enriched', $res->body['auth']['headers']['X-Custom']);
    }

    public function testBeforeDownHookIsCalled(): void
    {
        $called = false;
        $capturedScenarioName = null;

        $config = new HandlerConfig(
            scopeField: 'organizationId',
            sharedSecret: 'test-shared-secret',
            signingSecret: 'test-signing-secret',
            auth: fn($user) => ['credentials' => ['token' => 'test-token']],
            factories: ['Organization' => $this->orgFactory()],
            beforeDown: function (array $hookCtx) use (&$called, &$capturedScenarioName): void {
                $called = true;
                $capturedScenarioName = $hookCtx['scenarioName'];
            },
        );

        $refsToken = Refs::signRefs(
            ['refs' => ['Organization' => [['id' => 'org-1']]], 'testRunId' => 'run-123', 'environment' => ''],
            'test-signing-secret',
        );

        $body = json_encode(['action' => 'down', 'refsToken' => $refsToken]);
        $req = $this->makeRequest($body);
        $res = Handler::handleRequest($config, $req);

        $this->assertSame(200, $res->status);
        $this->assertTrue($called);
        $this->assertSame('run-123', $capturedScenarioName);
    }

    public function testFactoryCreateUsedOnUp(): void
    {
        $factoryCallCount = 0;
        $factoryReceivedData = null;

        $config = $this->makeConfig([
            'Organization' => Factory::define(
                create: function (array $data, FactoryContext $ctx) use (&$factoryCallCount, &$factoryReceivedData): array {
                    $factoryCallCount++;
                    $factoryReceivedData = $data;
                    return ['id' => 'factory-org-1', 'name' => $data['name']];
                },
                inputFields: [new FieldInfo('name', 'string', true)],
            ),
        ]);

        $body = json_encode([
            'action' => 'up',
            'create' => ['Organization' => [['name' => 'FactoryOrg', '_alias' => 'org1']]],
            'testRunId' => 'run-factory',
        ]);
        $req = $this->makeRequest($body);
        $res = Handler::handleRequest($config, $req);

        $this->assertSame(200, $res->status);
        $this->assertSame(1, $factoryCallCount);
        $this->assertSame('FactoryOrg', $factoryReceivedData['name']);
        $this->assertSame('factory-org-1', $res->body['refs']['Organization'][0]['id']);
    }

    public function testFactoryReceivesPreResolvedFkIds(): void
    {
        $receivedData = null;

        $config = $this->makeConfig([
            'Organization' => $this->orgFactory(),
            'User' => Factory::define(
                create: function (array $data, FactoryContext $ctx) use (&$receivedData): array {
                    $receivedData = $data;
                    return ['id' => 'user-1', 'email' => $data['email'], 'organization_id' => $data['organization_id'] ?? null];
                },
                inputFields: [
                    new FieldInfo('email', 'string', true),
                    new FieldInfo('name', 'string', true),
                    new FieldInfo('organization_id', 'string', true),
                ],
            ),
        ]);

        $body = json_encode([
            'action' => 'up',
            'create' => [
                'Organization' => [['name' => 'Org', '_alias' => 'org1']],
                'User' => [['email' => 'a@b.com', 'name' => 'A', 'organization_id' => ['_ref' => 'org1'], '_alias' => 'user1']],
            ],
            'testRunId' => 'run-fk',
        ]);
        $req = $this->makeRequest($body);
        $res = Handler::handleRequest($config, $req);

        $this->assertSame(200, $res->status);
        $this->assertNotNull($receivedData);
        $this->assertSame('org-Org', $receivedData['organization_id']);
    }

    public function testErrorsWhenFactoryDoesNotReturnPk(): void
    {
        $config = $this->makeConfig([
            'Organization' => Factory::define(
                create: fn(array $data, FactoryContext $ctx) => ['name' => $data['name']],
                inputFields: [new FieldInfo('name', 'string', true)],
            ),
        ]);

        $body = json_encode([
            'action' => 'up',
            'create' => ['Organization' => [['name' => 'NoPK', '_alias' => 'org1']]],
            'testRunId' => 'run-nopk',
        ]);
        $req = $this->makeRequest($body);
        $res = Handler::handleRequest($config, $req);

        $this->assertSame(500, $res->status);
        $this->assertSame('FACTORY_MISSING_PK', $res->body['code']);
    }

    public function testFactoryTeardownCalledPerRecordInReverseOrder(): void
    {
        $teardownCalls = [];

        $config = $this->makeConfig([
            'Organization' => Factory::define(
                create: fn(array $data, FactoryContext $ctx) => ['id' => 'org-' . $data['name'], 'name' => $data['name']],
                inputFields: [new FieldInfo('name', 'string', true)],
                teardown: function (array $record, FactoryContext $ctx) use (&$teardownCalls): void {
                    $teardownCalls[] = $record['id'];
                },
            ),
        ]);

        $upBody = json_encode([
            'action' => 'up',
            'create' => ['Organization' => [
                ['name' => 'A', '_alias' => 'orgA'],
                ['name' => 'B', '_alias' => 'orgB'],
            ]],
            'testRunId' => 'run-teardown',
        ]);
        $upReq = $this->makeRequest($upBody);
        $upRes = Handler::handleRequest($config, $upReq);
        $this->assertSame(200, $upRes->status);
        $refsToken = $upRes->body['refsToken'];

        $downBody = json_encode(['action' => 'down', 'refsToken' => $refsToken]);
        $downReq = $this->makeRequest($downBody);
        $downRes = Handler::handleRequest($config, $downReq);

        $this->assertSame(200, $downRes->status);
        $this->assertCount(2, $teardownCalls);
        $this->assertSame(['org-B', 'org-A'], $teardownCalls);
    }

    public function testFactoryContextContainsRefsOfPreviouslyCreatedModels(): void
    {
        $capturedCtx = null;

        $config = $this->makeConfig([
            'Organization' => $this->orgFactory(),
            'User' => Factory::define(
                create: function (array $data, FactoryContext $ctx) use (&$capturedCtx): array {
                    $capturedCtx = $ctx;
                    return ['id' => 'user-ctx', 'email' => $data['email'], 'organization_id' => $data['organization_id'] ?? null];
                },
                inputFields: [
                    new FieldInfo('email', 'string', true),
                    new FieldInfo('name', 'string', true),
                    new FieldInfo('organization_id', 'string', true),
                ],
            ),
        ]);

        $body = json_encode([
            'action' => 'up',
            'create' => [
                'Organization' => [['name' => 'Org', '_alias' => 'org1']],
                'User' => [['email' => 'x@y.com', 'name' => 'X', 'organization_id' => ['_ref' => 'org1'], '_alias' => 'user1']],
            ],
            'testRunId' => 'run-ctx',
        ]);
        $req = $this->makeRequest($body);
        Handler::handleRequest($config, $req);

        $this->assertNotNull($capturedCtx);
        $this->assertArrayHasKey('Organization', $capturedCtx->refs);
        $this->assertCount(1, $capturedCtx->refs['Organization']);
        $this->assertSame('org-Org', $capturedCtx->refs['Organization'][0]['id']);
        $this->assertSame('run-ctx', $capturedCtx->testRunId);
    }

    public function testDiscoverReturnsSchemaFromFactories(): void
    {
        $config = $this->makeConfig([
            'Organization' => $this->orgFactory(),
        ]);

        $body = '{"action":"discover"}';
        $req = $this->makeRequest($body);
        $res = Handler::handleRequest($config, $req);

        $this->assertSame(200, $res->status);
        $this->assertArrayHasKey('schema', $res->body);
        $this->assertArrayHasKey('models', $res->body['schema']);
        $this->assertNotEmpty($res->body['schema']['models']);

        $orgModel = null;
        foreach ($res->body['schema']['models'] as $m) {
            if ($m['name'] === 'Organization') {
                $orgModel = $m;
                break;
            }
        }
        $this->assertNotNull($orgModel);
        $this->assertSame('organizationId', $res->body['schema']['scopeField']);
    }
}
