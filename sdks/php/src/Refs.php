<?php
namespace Autonoma\Sdk;

class Refs
{
    /** Sign a refs payload into a 3-part token string. */
    public static function signRefs(array $payload, string $secret): string
    {
        $header = self::base64urlEncode(json_encode(['alg' => 'HS256', 'typ' => 'REFS'], JSON_UNESCAPED_SLASHES));
        $body = self::base64urlEncode(json_encode(self::serializeForJson($payload), JSON_UNESCAPED_SLASHES));
        $signature = self::hmacSign("{$header}.{$body}", $secret);
        return "{$header}.{$body}.{$signature}";
    }

    /**
     * Recursively serialize a value for JSON encoding.
     * Converts DateTime/DateTimeImmutable to ISO 8601 strings.
     */
    public static function serializeForJson(mixed $value): mixed
    {
        if ($value instanceof \DateTimeInterface) {
            return $value->format('c');
        }
        if (is_array($value)) {
            $result = [];
            foreach ($value as $k => $v) {
                $result[$k] = self::serializeForJson($v);
            }
            return $result;
        }
        return $value;
    }

    /** Verify and decode a teardown token. Returns payload array or throws. */
    public static function verifyRefs(string $token, string $secret): array
    {
        $parts = explode('.', $token);
        if (count($parts) !== 3) {
            throw new \InvalidArgumentException('malformed token');
        }
        [$header, $body, $signature] = $parts;
        $expected = self::hmacSign("{$header}.{$body}", $secret);
        if (!hash_equals($expected, $signature)) {
            throw new \InvalidArgumentException('signature mismatch');
        }
        $decoded = self::base64urlDecode($body);
        if ($decoded === false) {
            throw new \InvalidArgumentException('invalid base64url payload');
        }
        $payload = json_decode($decoded, true);
        if (!is_array($payload)) {
            throw new \InvalidArgumentException('invalid JSON payload');
        }
        return $payload;
    }

    public static function base64urlEncode(string $data): string
    {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }

    public static function base64urlDecode(string $data): string|false
    {
        $padding = 4 - (strlen($data) % 4);
        if ($padding !== 4) {
            $data .= str_repeat('=', $padding);
        }
        return base64_decode(strtr($data, '-_', '+/'), true);
    }

    private static function hmacSign(string $data, string $secret): string
    {
        $sig = hash_hmac('sha256', $data, $secret, true);
        return rtrim(strtr(base64_encode($sig), '+/', '-_'), '=');
    }
}
