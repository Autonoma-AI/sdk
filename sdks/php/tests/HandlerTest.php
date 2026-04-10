<?php

namespace Autonoma\Sdk\Tests;

use Autonoma\Sdk\Handler;
use Autonoma\Sdk\Hmac;
use Autonoma\Sdk\Refs;
use Autonoma\Sdk\Types\HandlerConfig;
use Autonoma\Sdk\Types\HandlerRequest;
use Autonoma\Sdk\Types\SQLExecutorInterface;
use PHPUnit\Framework\TestCase;

class HandlerTest extends TestCase
{
    private function makeConfig(?SQLExecutorInterface $executor = null): HandlerConfig
    {
        return new HandlerConfig(
            executor: $executor ?? $this->createMock(SQLExecutorInterface::class),
            scopeField: 'organizationId',
            sharedSecret: 'test-shared-secret',
            signingSecret: 'test-signing-secret',
            auth: fn($user) => ['credentials' => ['token' => 'test-token']],
        );
    }

    private function makeRequest(string $body, string $secret = 'test-shared-secret'): HandlerRequest
    {
        return new HandlerRequest(
            body: $body,
            headers: ['x-signature' => Hmac::signBody($body, $secret)],
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
            executor: $this->createMock(SQLExecutorInterface::class),
            scopeField: 'organizationId',
            sharedSecret: 'same-secret',
            signingSecret: 'same-secret',
            auth: fn($user) => ['credentials' => ['token' => 'test-token']],
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

    /**
     * Create a mock SQLExecutor that returns canned introspection data
     * and handles INSERT/DELETE/UPDATE queries.
     */
    private function createMockExecutor(): SQLExecutorInterface
    {
        $mockTables = [
            ['table_name' => 'organization'],
            ['table_name' => 'user'],
        ];
        $mockColumns = [
            ['table_name' => 'organization', 'column_name' => 'id', 'data_type' => 'uuid', 'udt_name' => 'uuid', 'is_nullable' => 'NO', 'column_default' => 'gen_random_uuid()'],
            ['table_name' => 'organization', 'column_name' => 'name', 'data_type' => 'text', 'udt_name' => 'text', 'is_nullable' => 'NO', 'column_default' => null],
            ['table_name' => 'user', 'column_name' => 'id', 'data_type' => 'uuid', 'udt_name' => 'uuid', 'is_nullable' => 'NO', 'column_default' => 'gen_random_uuid()'],
            ['table_name' => 'user', 'column_name' => 'email', 'data_type' => 'text', 'udt_name' => 'text', 'is_nullable' => 'NO', 'column_default' => null],
            ['table_name' => 'user', 'column_name' => 'name', 'data_type' => 'text', 'udt_name' => 'text', 'is_nullable' => 'NO', 'column_default' => null],
            ['table_name' => 'user', 'column_name' => 'organization_id', 'data_type' => 'uuid', 'udt_name' => 'uuid', 'is_nullable' => 'NO', 'column_default' => null],
        ];
        $mockPKs = [
            ['table_name' => 'organization', 'column_name' => 'id'],
            ['table_name' => 'user', 'column_name' => 'id'],
        ];
        $mockFKs = [
            ['from_table' => 'user', 'from_column' => 'organization_id', 'to_table' => 'organization', 'to_column' => 'id', 'is_nullable' => 'NO'],
        ];

        $insertCounter = 0;

        $executor = new class($mockTables, $mockColumns, $mockPKs, $mockFKs, $insertCounter) implements SQLExecutorInterface {
            private int $insertCounter;

            public function __construct(
                private array $mockTables,
                private array $mockColumns,
                private array $mockPKs,
                private array $mockFKs,
                int $insertCounter,
            ) {
                $this->insertCounter = $insertCounter;
            }

            public function query(string $sql, ?array $params = null): array
            {
                $trimmed = strtolower(trim($sql));

                // Introspection queries
                if (str_contains($trimmed, 'information_schema.tables') && !str_contains($trimmed, 'table_constraints')) {
                    return $this->mockTables;
                }
                if (str_contains($trimmed, 'information_schema.columns') && !str_contains($trimmed, 'table_constraints')) {
                    return $this->mockColumns;
                }
                if (str_contains($trimmed, 'foreign key')) {
                    return $this->mockFKs;
                }
                if (str_contains($trimmed, 'primary key')) {
                    return $this->mockPKs;
                }
                if (str_contains($trimmed, 'pg_type')) {
                    return [];
                }

                // INSERT: return a fake record
                if (str_starts_with($trimmed, 'insert')) {
                    $id = 'mock-id-' . $this->insertCounter++;
                    $record = ['id' => $id];
                    if ($params) {
                        preg_match('/\(([^)]+)\)\s*VALUES/i', $sql, $colMatch);
                        if ($colMatch) {
                            $cols = array_map(fn($c) => trim(str_replace('"', '', $c)), explode(',', $colMatch[1]));
                            foreach ($cols as $i => $col) {
                                if (isset($params[$i])) {
                                    $record[$col] = $params[$i];
                                }
                            }
                        }
                    }
                    return [$record];
                }

                // DELETE/UPDATE: return empty
                return [];
            }

            public function transaction(callable $fn): mixed
            {
                return $fn($this);
            }
        };

        return $executor;
    }

    public function testAfterUpHookModifiesAuth(): void
    {
        $executor = $this->createMockExecutor();
        $config = new HandlerConfig(
            executor: $executor,
            scopeField: 'organizationId',
            sharedSecret: 'test-shared-secret',
            signingSecret: 'test-signing-secret',
            auth: fn($user) => ['credentials' => ['token' => 'test-token']],
            afterUp: function (array $hookCtx, array $auth): array {
                $auth['headers'] = ['X-Custom' => 'enriched'];
                return $auth;
            },
        );

        $body = json_encode(['action' => 'up', 'create' => ['Organization' => [['name' => 'Org']]], 'testRunId' => 'run-123']);
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

        $executor = $this->createMockExecutor();
        $config = new HandlerConfig(
            executor: $executor,
            scopeField: 'organizationId',
            sharedSecret: 'test-shared-secret',
            signingSecret: 'test-signing-secret',
            auth: fn($user) => ['credentials' => ['token' => 'test-token']],
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
}
