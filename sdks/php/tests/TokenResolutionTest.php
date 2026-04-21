<?php

declare(strict_types=1);

use Autonoma\Sdk\AutonomaError;
use Autonoma\Sdk\Handler;
use PHPUnit\Framework\TestCase;

final class TokenResolutionTest extends TestCase
{
    public function testTestRunIdSubstituted(): void
    {
        $out = Handler::resolveTokens(['email' => 'alice-{{testRunId}}@test.local'], 'run-123', 0);
        $this->assertSame(['email' => 'alice-run-123@test.local'], $out);
    }

    public function testIndexSubstituted(): void
    {
        $out = Handler::resolveTokens(['slot' => 'pos-{{index}}'], 'r', 4);
        $this->assertSame(['slot' => 'pos-4'], $out);
    }

    public function testCycleSubstitutedAndWraps(): void
    {
        $this->assertSame('a', Handler::resolveTokens('{{cycle(a,b)}}', 'r', 0));
        $this->assertSame('b', Handler::resolveTokens('{{cycle(a,b)}}', 'r', 1));
        $this->assertSame('a', Handler::resolveTokens('{{cycle(a,b)}}', 'r', 2));
    }

    public function testCycleQuotedValuesStripped(): void
    {
        $this->assertSame('IOS', Handler::resolveTokens("{{cycle('WEB','IOS','ANDROID')}}", 'r', 1));
    }

    public function testNestedStructuresWalked(): void
    {
        $input = [
            'users' => [
                ['email' => 'u-{{testRunId}}@t.local'],
                ['email' => 'v-{{testRunId}}@t.local'],
            ],
            'tags' => ['{{testRunId}}-a', '{{testRunId}}-b'],
        ];
        $expected = [
            'users' => [
                ['email' => 'u-xyz@t.local'],
                ['email' => 'v-xyz@t.local'],
            ],
            'tags' => ['xyz-a', 'xyz-b'],
        ];
        $this->assertSame($expected, Handler::resolveTokens($input, 'xyz', 0));
    }

    public function testMultipleTokensInOneString(): void
    {
        $this->assertSame('run-7', Handler::resolveTokens('{{testRunId}}-{{index}}', 'run', 7));
    }

    public function testUnknownTokenRaises(): void
    {
        try {
            Handler::resolveTokens(['x' => 'hello-{{mystery}}'], 'r', 0);
            $this->fail('Expected AutonomaError');
        } catch (AutonomaError $e) {
            $this->assertSame('UNRESOLVED_TOKEN', $e->errorCode);
            $this->assertStringContainsString('mystery', $e->getMessage());
        }
    }

    public function testNonStringPrimitivesPassThrough(): void
    {
        $this->assertSame(42, Handler::resolveTokens(42, 'r', 0));
        $this->assertTrue(Handler::resolveTokens(true, 'r', 0));
        $this->assertNull(Handler::resolveTokens(null, 'r', 0));
    }

    public function testStringWithoutTokensUnchanged(): void
    {
        $this->assertSame('plain string', Handler::resolveTokens('plain string', 'r', 0));
    }
}
