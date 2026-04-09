<?php
namespace Autonoma\Sdk;

class Fingerprint
{
    /** Compute a 16-char hex fingerprint of any JSON-serializable value. */
    public static function fingerprint(mixed $value): string
    {
        $normalized = self::sortKeys($value);
        $json = json_encode($normalized, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        return substr(hash('sha256', $json), 0, 16);
    }

    /** Recursively sort object keys for deterministic serialization. */
    private static function sortKeys(mixed $obj): mixed
    {
        if (is_array($obj)) {
            // Check if it's an associative array (object-like)
            if (self::isAssoc($obj)) {
                ksort($obj);
                return array_map([self::class, 'sortKeys'], $obj);
            }
            // Sequential array
            return array_map([self::class, 'sortKeys'], $obj);
        }
        return $obj;
    }

    private static function isAssoc(array $arr): bool
    {
        if (empty($arr)) return false;
        return array_keys($arr) !== range(0, count($arr) - 1);
    }
}
