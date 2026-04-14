<?php

namespace Autonoma\Sdk\Tests;

use Autonoma\Sdk\Factory;
use Autonoma\Sdk\Handler;
use Autonoma\Sdk\Hmac;
use Autonoma\Sdk\Refs;
use Autonoma\Sdk\Types\FactoryContext;
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
            auth: fn($user, $ctx) => ['credentials' => ['token' => 'test-token']],
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

    /**
     * Create a mock executor that also tracks all queries issued.
     * @return SQLExecutorInterface&object{queries: string[]}
     */
    private function createTrackingMockExecutor(): SQLExecutorInterface
    {
        return new class implements SQLExecutorInterface {
            public array $queries = [];
            private int $insertCounter = 0;

            private array $mockTables = [
                ['table_name' => 'organization'],
                ['table_name' => 'user'],
            ];
            private array $mockColumns = [
                ['table_name' => 'organization', 'column_name' => 'id', 'data_type' => 'uuid', 'udt_name' => 'uuid', 'is_nullable' => 'NO', 'column_default' => 'gen_random_uuid()'],
                ['table_name' => 'organization', 'column_name' => 'name', 'data_type' => 'text', 'udt_name' => 'text', 'is_nullable' => 'NO', 'column_default' => null],
                ['table_name' => 'user', 'column_name' => 'id', 'data_type' => 'uuid', 'udt_name' => 'uuid', 'is_nullable' => 'NO', 'column_default' => 'gen_random_uuid()'],
                ['table_name' => 'user', 'column_name' => 'email', 'data_type' => 'text', 'udt_name' => 'text', 'is_nullable' => 'NO', 'column_default' => null],
                ['table_name' => 'user', 'column_name' => 'name', 'data_type' => 'text', 'udt_name' => 'text', 'is_nullable' => 'NO', 'column_default' => null],
                ['table_name' => 'user', 'column_name' => 'organization_id', 'data_type' => 'uuid', 'udt_name' => 'uuid', 'is_nullable' => 'NO', 'column_default' => null],
            ];
            private array $mockPKs = [
                ['table_name' => 'organization', 'column_name' => 'id'],
                ['table_name' => 'user', 'column_name' => 'id'],
            ];
            private array $mockFKs = [
                ['from_table' => 'user', 'from_column' => 'organization_id', 'to_table' => 'organization', 'to_column' => 'id', 'is_nullable' => 'NO'],
            ];

            public function query(string $sql, ?array $params = null): array
            {
                $this->queries[] = $sql;
                $trimmed = strtolower(trim($sql));

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

                return [];
            }

            public function transaction(callable $fn): mixed
            {
                return $fn($this);
            }
        };
    }

    // --- Factory tests ---

    public function testFactoryCreateUsedInsteadOfSql(): void
    {
        $factoryCallCount = 0;
        $factoryReceivedData = null;

        $executor = $this->createTrackingMockExecutor();
        $config = new HandlerConfig(
            executor: $executor,
            scopeField: 'organizationId',
            sharedSecret: 'test-shared-secret',
            signingSecret: 'test-signing-secret',
            auth: fn($user) => ['credentials' => ['token' => 'test-token']],
            factories: [
                'Organization' => Factory::define(
                    function (array $data, FactoryContext $ctx) use (&$factoryCallCount, &$factoryReceivedData): array {
                        $factoryCallCount++;
                        $factoryReceivedData = $data;
                        return ['id' => 'factory-org-1', 'name' => $data['name']];
                    }
                ),
            ],
        );

        $body = json_encode(['action' => 'up', 'create' => ['Organization' => [['name' => 'FactoryOrg']]], 'testRunId' => 'run-factory']);
        $req = $this->makeRequest($body);
        $res = Handler::handleRequest($config, $req);

        $this->assertSame(200, $res->status);
        $this->assertSame(1, $factoryCallCount);
        $this->assertSame('FactoryOrg', $factoryReceivedData['name']);
        $this->assertSame('factory-org-1', $res->body['refs']['Organization'][0]['id']);

        // No INSERT query for Organization should have been issued
        $orgInserts = array_filter($executor->queries, fn($q) => str_contains(strtolower($q), 'insert') && str_contains(strtolower($q), 'organization'));
        $this->assertCount(0, $orgInserts);
    }

    public function testHybridModeFactoryForSomeModelsSqlForOthers(): void
    {
        $factoryCallCount = 0;

        $executor = $this->createTrackingMockExecutor();
        $config = new HandlerConfig(
            executor: $executor,
            scopeField: 'organizationId',
            sharedSecret: 'test-shared-secret',
            signingSecret: 'test-signing-secret',
            auth: fn($user) => ['credentials' => ['token' => 'test-token']],
            factories: [
                'Organization' => Factory::define(
                    function (array $data) use (&$factoryCallCount): array {
                        $factoryCallCount++;
                        return ['id' => 'factory-org-1', 'name' => $data['name']];
                    }
                ),
                // User has no factory - falls back to SQL
            ],
        );

        $body = json_encode([
            'action' => 'up',
            'create' => [
                'Organization' => [['name' => 'HybridOrg']],
                'User' => [['email' => 'test@example.com', 'name' => 'Test']],
            ],
            'testRunId' => 'run-hybrid',
        ]);
        $req = $this->makeRequest($body);
        $res = Handler::handleRequest($config, $req);

        $this->assertSame(200, $res->status);
        $this->assertSame(1, $factoryCallCount);

        // User should have been created via SQL INSERT
        $userInserts = array_filter($executor->queries, fn($q) => str_contains(strtolower($q), 'insert') && str_contains(strtolower($q), '"user"'));
        $this->assertGreaterThan(0, count($userInserts));
    }

    public function testFactoryReceivesPreResolvedFkIds(): void
    {
        $receivedData = null;

        $executor = $this->createTrackingMockExecutor();
        $config = new HandlerConfig(
            executor: $executor,
            scopeField: 'organizationId',
            sharedSecret: 'test-shared-secret',
            signingSecret: 'test-signing-secret',
            auth: fn($user) => ['credentials' => ['token' => 'test-token']],
            factories: [
                'Organization' => Factory::define(
                    fn(array $data) => ['id' => 'resolved-org-id', 'name' => $data['name']],
                ),
                'User' => Factory::define(
                    function (array $data) use (&$receivedData): array {
                        $receivedData = $data;
                        return ['id' => 'user-1', 'email' => $data['email'], 'organizationId' => $data['organizationId'] ?? null];
                    }
                ),
            ],
        );

        // Nest User under Organization so tree resolver wires the FK
        $body = json_encode([
            'action' => 'up',
            'create' => [
                'Organization' => [['name' => 'Org', 'User' => [['email' => 'a@b.com', 'name' => 'A']]]],
            ],
            'testRunId' => 'run-fk',
        ]);
        $req = $this->makeRequest($body);
        $res = Handler::handleRequest($config, $req);

        $this->assertSame(200, $res->status);
        $this->assertNotNull($receivedData);
        // The User factory should receive the real org ID, not __temp_Organization_0
        $this->assertSame('resolved-org-id', $receivedData['organizationId']);
    }

    public function testErrorsWhenFactoryDoesNotReturnPk(): void
    {
        $executor = $this->createTrackingMockExecutor();
        $config = new HandlerConfig(
            executor: $executor,
            scopeField: 'organizationId',
            sharedSecret: 'test-shared-secret',
            signingSecret: 'test-signing-secret',
            auth: fn($user) => ['credentials' => ['token' => 'test-token']],
            factories: [
                'Organization' => Factory::define(
                    fn(array $data) => ['name' => $data['name']], // missing 'id'
                ),
            ],
        );

        $body = json_encode(['action' => 'up', 'create' => ['Organization' => [['name' => 'NoPK']]], 'testRunId' => 'run-nopk']);
        $req = $this->makeRequest($body);
        $res = Handler::handleRequest($config, $req);

        $this->assertSame(500, $res->status);
        $this->assertSame('FACTORY_MISSING_PK', $res->body['code']);
    }

    public function testFactoryTeardownCalledPerRecordInReverseOrder(): void
    {
        $teardownCalls = [];

        $executor = $this->createTrackingMockExecutor();
        $config = new HandlerConfig(
            executor: $executor,
            scopeField: 'organizationId',
            sharedSecret: 'test-shared-secret',
            signingSecret: 'test-signing-secret',
            auth: fn($user) => ['credentials' => ['token' => 'test-token']],
            factories: [
                'Organization' => Factory::define(
                    create: fn(array $data) => ['id' => 'org-' . $data['name'], 'name' => $data['name']],
                    teardown: function (array $record) use (&$teardownCalls): void {
                        $teardownCalls[] = $record['id'];
                    },
                ),
            ],
        );

        // First create
        $upBody = json_encode([
            'action' => 'up',
            'create' => ['Organization' => [['name' => 'A'], ['name' => 'B']]],
            'testRunId' => 'run-teardown',
        ]);
        $upReq = $this->makeRequest($upBody);
        $upRes = Handler::handleRequest($config, $upReq);
        $this->assertSame(200, $upRes->status);
        $refsToken = $upRes->body['refsToken'];

        // Then teardown
        $downBody = json_encode(['action' => 'down', 'refsToken' => $refsToken]);
        $downReq = $this->makeRequest($downBody);
        $downRes = Handler::handleRequest($config, $downReq);

        $this->assertSame(200, $downRes->status);
        $this->assertCount(2, $teardownCalls);
        // Reverse order: B first, then A
        $this->assertSame(['org-B', 'org-A'], $teardownCalls);
    }

    public function testSqlTeardownUsedWhenFactoryHasNoTeardown(): void
    {
        $executor = $this->createTrackingMockExecutor();
        $config = new HandlerConfig(
            executor: $executor,
            scopeField: 'organizationId',
            sharedSecret: 'test-shared-secret',
            signingSecret: 'test-signing-secret',
            auth: fn($user) => ['credentials' => ['token' => 'test-token']],
            factories: [
                'Organization' => Factory::define(
                    fn(array $data) => ['id' => 'org-1', 'name' => $data['name']],
                    // No teardown - SQL DELETE should be used
                ),
            ],
        );

        $upBody = json_encode(['action' => 'up', 'create' => ['Organization' => [['name' => 'Org']]], 'testRunId' => 'run-sql-td']);
        $upReq = $this->makeRequest($upBody);
        $upRes = Handler::handleRequest($config, $upReq);
        $this->assertSame(200, $upRes->status);

        // Clear queries tracked during up
        $executor->queries = [];

        $refsToken = $upRes->body['refsToken'];
        $downBody = json_encode(['action' => 'down', 'refsToken' => $refsToken]);
        $downReq = $this->makeRequest($downBody);
        $downRes = Handler::handleRequest($config, $downReq);

        $this->assertSame(200, $downRes->status);
        // SQL DELETE should have been used
        $deleteQueries = array_filter($executor->queries, fn($q) => str_contains(strtolower($q), 'delete'));
        $this->assertGreaterThan(0, count($deleteQueries));
    }

    public function testFactoryContextContainsRefsOfPreviouslyCreatedModels(): void
    {
        $capturedCtx = null;

        $executor = $this->createTrackingMockExecutor();
        $config = new HandlerConfig(
            executor: $executor,
            scopeField: 'organizationId',
            sharedSecret: 'test-shared-secret',
            signingSecret: 'test-signing-secret',
            auth: fn($user) => ['credentials' => ['token' => 'test-token']],
            factories: [
                'Organization' => Factory::define(
                    fn(array $data) => ['id' => 'org-ctx', 'name' => $data['name']],
                ),
                'User' => Factory::define(
                    function (array $data, FactoryContext $ctx) use (&$capturedCtx): array {
                        $capturedCtx = $ctx;
                        return ['id' => 'user-ctx', 'email' => $data['email'], 'organizationId' => $data['organizationId'] ?? null];
                    }
                ),
            ],
        );

        $body = json_encode([
            'action' => 'up',
            'create' => [
                'Organization' => [['name' => 'Org']],
                'User' => [['email' => 'x@y.com', 'name' => 'X']],
            ],
            'testRunId' => 'run-ctx',
        ]);
        $req = $this->makeRequest($body);
        Handler::handleRequest($config, $req);

        $this->assertNotNull($capturedCtx);
        // By the time User factory runs, Organization should already be in refs
        $this->assertArrayHasKey('Organization', $capturedCtx->refs);
        $this->assertCount(1, $capturedCtx->refs['Organization']);
        $this->assertSame('org-ctx', $capturedCtx->refs['Organization'][0]['id']);
        $this->assertSame('run-ctx', $capturedCtx->testRunId);
    }
}
