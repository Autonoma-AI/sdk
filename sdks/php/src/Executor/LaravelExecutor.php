<?php

namespace Autonoma\Sdk\Executor;

use Autonoma\Sdk\Types\SQLExecutorInterface;
use Illuminate\Support\Facades\DB;

class LaravelExecutor implements SQLExecutorInterface
{
    public function __construct(
        private readonly ?string $connection = null,
    ) {}

    /**
     * Execute a raw SQL query and return rows as associative arrays.
     * Converts Postgres-style $1, $2, ... placeholders to ? for PDO.
     */
    public function query(string $sql, ?array $params = null): array
    {
        $converted = $this->convertParams($sql);
        $db = $this->connection ? DB::connection($this->connection) : DB::connection();

        if ($params === null || empty($params)) {
            $results = $db->select($converted);
        } else {
            // Determine if this is a SELECT, INSERT...RETURNING, or write statement
            $trimmed = ltrim($converted);
            if (preg_match('/^SELECT\b/i', $trimmed) ||
                preg_match('/RETURNING\s/i', $converted)) {
                $results = $db->select($converted, $params);
            } else {
                $db->statement($converted, $params);
                return [];
            }
        }

        // Convert stdClass objects to associative arrays
        return array_map(fn($row) => (array) $row, $results);
    }

    /**
     * Execute a callback within a database transaction.
     */
    public function transaction(callable $fn): mixed
    {
        $db = $this->connection ? DB::connection($this->connection) : DB::connection();
        return $db->transaction(function () use ($fn) {
            // Create a transaction-scoped executor that uses the same connection
            $txExecutor = new self($this->connection);
            return $fn($txExecutor);
        });
    }

    /**
     * Convert Postgres-style $1, $2, ... placeholders to ? for PDO.
     * Preserves Postgres type casts like $1::"EnumType".
     */
    private function convertParams(string $sql): string
    {
        // Replace $N (not preceded by backslash) with ?, preserving type casts
        return preg_replace('/\$\d+/', '?', $sql);
    }
}
