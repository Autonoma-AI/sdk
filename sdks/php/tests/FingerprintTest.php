<?php

namespace Autonoma\Sdk\Tests;

use Autonoma\Sdk\Fingerprint;
use PHPUnit\Framework\TestCase;

class FingerprintTest extends TestCase
{
    public function testReturns16CharHex(): void
    {
        $fp = Fingerprint::fingerprint(['name' => 'test']);
        $this->assertSame(16, strlen($fp));
        $this->assertMatchesRegularExpression('/^[0-9a-f]{16}$/', $fp);
    }

    public function testIsDeterministic(): void
    {
        $a = Fingerprint::fingerprint(['a' => 1, 'b' => 2]);
        $b = Fingerprint::fingerprint(['a' => 1, 'b' => 2]);
        $this->assertSame($a, $b);
    }

    public function testKeyOrderIndependent(): void
    {
        $a = Fingerprint::fingerprint(['a' => 1, 'b' => 2]);
        $b = Fingerprint::fingerprint(['b' => 2, 'a' => 1]);
        $this->assertSame($a, $b);
    }

    public function testDifferentValuesProduceDifferentFingerprints(): void
    {
        $a = Fingerprint::fingerprint(['name' => 'foo']);
        $b = Fingerprint::fingerprint(['name' => 'bar']);
        $this->assertNotSame($a, $b);
    }

    public function testKnownVectors(): void
    {
        $this->assertSame('7d9fd2051fc32b32', Fingerprint::fingerprint(['name' => 'test']));
        $this->assertSame('a615eeaee21de517', Fingerprint::fingerprint([1, 2, 3]));
    }
}
