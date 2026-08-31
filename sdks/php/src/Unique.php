<?php

namespace Autonoma\Sdk;

/**
 * Deterministic uniqueness helpers seeded from testRunId. A scenario's data
 * needs stable keys across runs but unique values per run (unique emails, org
 * slugs, ids). These derive that uniqueness from (testRunId, ...parts): the
 * same inputs always produce the same output within a run, so a scenario's up
 * and a later down compute identical values without storing them.
 *
 * The recipe is sha256(testRunId . (" " . part) for each part), hex-encoded,
 * truncated to the first 12 chars - and MUST match the other language SDKs
 * byte-for-byte for cross-language conformance.
 */
class Unique
{
    private const TOKEN_LENGTH = 12;

    private static function digest(string $testRunId, array $parts): string
    {
        $data = $testRunId;
        foreach ($parts as $part) {
            $data .= ' ' . (string) $part;
        }
        return hash('sha256', $data);
    }

    /** A short hex token, deterministic per (testRunId, ...parts). */
    public static function uniqueToken(string $testRunId, string|int ...$parts): string
    {
        return substr(self::digest($testRunId, $parts), 0, self::TOKEN_LENGTH);
    }

    /**
     * An id like "user_1a2b3c4d5e6f", deterministic per inputs. An empty prefix
     * defaults to "id".
     */
    public static function uniqueId(string $testRunId, string $prefix = 'id', string|int ...$parts): string
    {
        if ($prefix === '') {
            $prefix = 'id';
        }
        return $prefix . '_' . self::uniqueToken($testRunId, $prefix, ...$parts);
    }

    /**
     * A URL-safe slug like "acme-1a2b3c4d5e6f", deterministic per inputs. An
     * empty base defaults to "item".
     */
    public static function uniqueSlug(string $testRunId, string $base = 'item', string|int ...$parts): string
    {
        if ($base === '') {
            $base = 'item';
        }
        $token = self::uniqueToken($testRunId, $base, ...$parts);
        $normalized = preg_replace('/^-+|-+$/', '', preg_replace('/[^a-z0-9]+/', '-', strtolower($base)));
        if ($normalized === '' || $normalized === null) {
            $normalized = 'item';
        }
        return $normalized . '-' . $token;
    }

    /**
     * An email like "user+1a2b3c4d5e6f@example.com", deterministic per inputs.
     * Empty local/domain default to "user"/"example.com".
     */
    public static function uniqueEmail(string $testRunId, string $local = 'user', string $domain = 'example.com'): string
    {
        if ($local === '') {
            $local = 'user';
        }
        if ($domain === '') {
            $domain = 'example.com';
        }
        return $local . '+' . self::uniqueToken($testRunId, $local, $domain) . '@' . $domain;
    }
}
