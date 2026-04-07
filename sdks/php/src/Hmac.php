<?php
namespace Autonoma\Sdk;

class Hmac
{
    /** Sign a body string with HMAC-SHA256. Returns 64-char lowercase hex. */
    public static function signBody(string $body, string $secret): string
    {
        return hash_hmac('sha256', $body, $secret);
    }

    /** Verify a signature using timing-safe comparison. */
    public static function verifySignature(string $body, string $signature, string $secret): bool
    {
        $expected = self::signBody($body, $secret);
        return hash_equals($expected, $signature);
    }
}
