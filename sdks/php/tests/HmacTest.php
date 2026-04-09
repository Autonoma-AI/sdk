<?php

namespace Autonoma\Sdk\Tests;

use Autonoma\Sdk\Hmac;
use PHPUnit\Framework\TestCase;

class HmacTest extends TestCase
{
    public function testSignBodyReturns64CharHex(): void
    {
        $sig = Hmac::signBody('{"action":"discover"}', 'test-secret-key');
        $this->assertSame(64, strlen($sig));
        $this->assertMatchesRegularExpression('/^[0-9a-f]{64}$/', $sig);
    }

    public function testSignBodyIsDeterministic(): void
    {
        $a = Hmac::signBody('hello', 'secret');
        $b = Hmac::signBody('hello', 'secret');
        $this->assertSame($a, $b);
    }

    public function testSignBodyDifferentSecretsProduceDifferentSignatures(): void
    {
        $a = Hmac::signBody('body', 'secret-a');
        $b = Hmac::signBody('body', 'secret-b');
        $this->assertNotSame($a, $b);
    }

    public function testVerifySignatureValid(): void
    {
        $sig = Hmac::signBody('{"action":"discover"}', 'my-secret');
        $this->assertTrue(Hmac::verifySignature('{"action":"discover"}', $sig, 'my-secret'));
    }

    public function testVerifySignatureInvalid(): void
    {
        $this->assertFalse(Hmac::verifySignature('body', 'invalid-sig', 'secret'));
    }

    public function testVerifySignatureWrongSecret(): void
    {
        $sig = Hmac::signBody('body', 'correct-secret');
        $this->assertFalse(Hmac::verifySignature('body', $sig, 'wrong-secret'));
    }

    public function testKnownVector(): void
    {
        // Known test vector from conformance tests
        $sig = Hmac::signBody('{"action":"discover"}', 'test-secret-key');
        $this->assertSame('2c5588170f06ff28479566d72d45969927913c56bcba01d36c3122f2284cbba2', $sig);
    }
}
