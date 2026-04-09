<?php

namespace Autonoma\Sdk\Tests;

use Autonoma\Sdk\Refs;
use PHPUnit\Framework\TestCase;

class RefsTest extends TestCase
{
    public function testSignAndVerifyRoundTrip(): void
    {
        $payload = ['refs' => ['User' => [['id' => '123']]], 'testRunId' => 'run-1', 'environment' => 'test'];
        $token = Refs::signRefs($payload, 'my-signing-secret');

        $this->assertIsString($token);
        $parts = explode('.', $token);
        $this->assertCount(3, $parts);

        $decoded = Refs::verifyRefs($token, 'my-signing-secret');
        $this->assertSame($payload, $decoded);
    }

    public function testVerifyRejectsWrongSecret(): void
    {
        $payload = ['refs' => [], 'testRunId' => 'run-1', 'environment' => ''];
        $token = Refs::signRefs($payload, 'secret-a');

        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('signature mismatch');
        Refs::verifyRefs($token, 'secret-b');
    }

    public function testVerifyRejectsMalformedToken(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('malformed token');
        Refs::verifyRefs('not.valid', 'secret');
    }

    public function testTokenHasThreeParts(): void
    {
        $token = Refs::signRefs(['data' => 'test'], 'secret');
        $parts = explode('.', $token);
        $this->assertCount(3, $parts);
    }

    public function testHeaderContainsCorrectAlg(): void
    {
        $token = Refs::signRefs(['data' => 'test'], 'secret');
        $header = json_decode(Refs::base64urlDecode(explode('.', $token)[0]), true);
        $this->assertSame('HS256', $header['alg']);
        $this->assertSame('REFS', $header['typ']);
    }
}
