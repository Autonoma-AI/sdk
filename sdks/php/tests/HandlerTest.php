<?php

namespace Autonoma\Sdk\Tests;

use Autonoma\Sdk\Handler;
use Autonoma\Sdk\Hmac;
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
}
