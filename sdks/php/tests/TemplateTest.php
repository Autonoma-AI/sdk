<?php

namespace Autonoma\Sdk\Tests;

use Autonoma\Sdk\Template;
use PHPUnit\Framework\TestCase;

class TemplateTest extends TestCase
{
    public function testReplacesTestRunId(): void
    {
        $result = Template::resolveTemplate('{{testRunId}}', ['testRunId' => 'run-abc123']);
        $this->assertSame('run-abc123', $result);
    }

    public function testReplacesIndex(): void
    {
        $result = Template::resolveTemplate('{{index}}', ['index' => 3]);
        $this->assertSame(3, $result);
    }

    public function testReplacesIndex1(): void
    {
        $result = Template::resolveTemplate('{{index1}}', ['index' => 0]);
        $this->assertSame(1, $result);
    }

    public function testInterpolatesInString(): void
    {
        $result = Template::resolveTemplate('admin-{{testRunId}}@autonoma.dev', ['testRunId' => 'run-abc123']);
        $this->assertSame('admin-run-abc123@autonoma.dev', $result);
    }

    public function testCycleExpression(): void
    {
        $result0 = Template::resolveTemplate("{{cycle(['a', 'b', 'c'])}}", ['index' => 0]);
        $result1 = Template::resolveTemplate("{{cycle(['a', 'b', 'c'])}}", ['index' => 1]);
        $result3 = Template::resolveTemplate("{{cycle(['a', 'b', 'c'])}}", ['index' => 3]);
        $this->assertSame('a', $result0);
        $this->assertSame('b', $result1);
        $this->assertSame('a', $result3); // wraps around
    }

    public function testRandomInt(): void
    {
        $result = Template::resolveTemplate('{{random.int(1, 100)}}', []);
        $this->assertIsInt($result);
        $this->assertGreaterThanOrEqual(1, $result);
        $this->assertLessThanOrEqual(100, $result);
    }

    public function testRandomFloat(): void
    {
        $result = Template::resolveTemplate('{{random.float(1.5, 9.9)}}', []);
        $this->assertIsFloat($result);
        $this->assertGreaterThanOrEqual(1.5, $result);
        $this->assertLessThanOrEqual(9.9, $result);
    }

    public function testNowReturnsIso8601(): void
    {
        $result = Template::resolveTemplate('{{now()}}', []);
        $this->assertIsString($result);
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/', $result);
    }

    public function testDaysAgoReturnsIso8601(): void
    {
        $result = Template::resolveTemplate('{{daysAgo(7)}}', []);
        $this->assertIsString($result);
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/', $result);
    }

    public function testResolvesNestedObjects(): void
    {
        $result = Template::resolveTemplate(
            ['name' => '{{testRunId}}', 'nested' => ['val' => '{{index}}']],
            ['testRunId' => 'run-1', 'index' => 5],
        );
        $this->assertSame(['name' => 'run-1', 'nested' => ['val' => 5]], $result);
    }

    public function testResolvesArrays(): void
    {
        $result = Template::resolveTemplate(['{{testRunId}}', '{{index}}'], ['testRunId' => 'run-1', 'index' => 0]);
        $this->assertSame(['run-1', 0], $result);
    }

    public function testNonStringPassthrough(): void
    {
        $this->assertSame(42, Template::resolveTemplate(42, []));
        $this->assertSame(true, Template::resolveTemplate(true, []));
        $this->assertSame(null, Template::resolveTemplate(null, []));
    }

    public function testPickReturnsOneOfValues(): void
    {
        $result = Template::resolveTemplate("{{pick(['x', 'y', 'z'])}}", []);
        $this->assertContains($result, ['x', 'y', 'z']);
    }

    public function testUnknownExpressionThrows(): void
    {
        $this->expectException(\RuntimeException::class);
        Template::resolveTemplate('{{unknownExpr}}', []);
    }
}
