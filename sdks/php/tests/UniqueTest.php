<?php

namespace Autonoma\Sdk\Tests;

use Autonoma\Sdk\Unique;
use PHPUnit\Framework\TestCase;

class UniqueTest extends TestCase
{
    /**
     * These vectors are cross-checked against the TypeScript unique.ts recipe so
     * the same (testRunId, ...parts) yields byte-identical output across all
     * language SDKs.
     */
    public function testCrossLanguageVectors(): void
    {
        $this->assertSame('4e65d3fbe8ad', Unique::uniqueToken('run-1'));
        $this->assertSame('user+039af36014b8@example.com', Unique::uniqueEmail('run-1'));
        $this->assertSame('acme-b6446df155f8', Unique::uniqueSlug('run-1', 'Acme'));
        $this->assertSame('user_776b5cbfd0f0', Unique::uniqueId('run-1', 'user'));
    }

    public function testTokenShape(): void
    {
        $token = Unique::uniqueToken('run', 'a', 'b');
        $this->assertSame(12, strlen($token));
        $this->assertMatchesRegularExpression('/^[0-9a-f]{12}$/', $token);
    }

    public function testDeterministicAndSeeded(): void
    {
        // Same inputs, same output.
        $this->assertSame(Unique::uniqueToken('run', 'x'), Unique::uniqueToken('run', 'x'));
        // Different testRunId, different output.
        $this->assertNotSame(Unique::uniqueToken('run-a', 'x'), Unique::uniqueToken('run-b', 'x'));
        // Different parts, different output.
        $this->assertNotSame(Unique::uniqueToken('run', 'x'), Unique::uniqueToken('run', 'y'));
    }

    public function testSlugNormalization(): void
    {
        $this->assertMatchesRegularExpression(
            '/^acme-corp-[0-9a-f]{12}$/',
            Unique::uniqueSlug('run', 'Acme Corp!!'),
        );
        // A base that normalizes to empty falls back to "item".
        $this->assertMatchesRegularExpression(
            '/^item-[0-9a-f]{12}$/',
            Unique::uniqueSlug('run', '!!!'),
        );
    }

    public function testDefaultsForEmptyInputs(): void
    {
        $this->assertSame('id_' . Unique::uniqueToken('run', 'id'), Unique::uniqueId('run', ''));
        $this->assertStringStartsWith('item-', Unique::uniqueSlug('run', ''));
        $this->assertStringEndsWith('@example.com', Unique::uniqueEmail('run', '', ''));
    }
}
