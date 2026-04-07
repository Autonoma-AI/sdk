<?php

namespace Autonoma\Sdk;

use Autonoma\Sdk\Dialect\DialectInterface;
use Autonoma\Sdk\Types\SQLExecutorInterface;

class Create
{
    /**
     * Create entities from a resolved spec.
     * Spec maps model name → ['count' => int, 'fields' => array[], 'batch' => bool].
     *
     * @return array<string, array<int, array<string, mixed>>>
     */
    public static function createEntities(
        SQLExecutorInterface $executor,
        DialectInterface $dialect,
        array $tableMap,
        array $columnMaps,
        array $spec,
        array $enumTypeMaps = [],
    ): array {
        $results = [];

        foreach ($spec as $model => $entitySpec) {
            $dbTable = $tableMap[$model] ?? null;
            if ($dbTable === null) {
                throw new \RuntimeException("Unknown model \"{$model}\". Not found in database tables.");
            }
            $colMap = $columnMaps[$model] ?? [];
            $enumTypeMap = $enumTypeMaps[$model] ?? [];

            $fieldsList = $entitySpec['fields'] ?? [];
            $isBatch = $entitySpec['batch'] ?? false;

            if ($isBatch && !empty($fieldsList)) {
                $results[$model] = self::insertBatch($executor, $dialect, $dbTable, $colMap, $enumTypeMap, $fieldsList);
            } else {
                $created = [];
                foreach ($fieldsList as $fields) {
                    $rows = self::insertOne($executor, $dialect, $dbTable, $colMap, $enumTypeMap, $fields);
                    if (!empty($rows)) {
                        $created[] = $rows[0];
                    }
                }
                $results[$model] = $created;
            }
        }

        return $results;
    }

    /**
     * Update a single record by primary key. Used for circular FK backfill.
     */
    public static function updateEntity(
        SQLExecutorInterface $executor,
        DialectInterface $dialect,
        array $tableMap,
        array $columnMaps,
        string $model,
        string $recordId,
        array $fields,
        array $enumTypeMaps = [],
    ): void {
        $dbTable = $tableMap[$model] ?? null;
        if ($dbTable === null) {
            throw new \RuntimeException("Unknown model \"{$model}\" for update.");
        }
        $colMap = $columnMaps[$model] ?? [];
        $enumTypeMap = ($enumTypeMaps)[$model] ?? [];

        $setClauses = [];
        $params = [];
        $paramIdx = 1;

        foreach ($fields as $fieldName => $value) {
            $dbCol = $colMap[$fieldName] ?? $fieldName;
            $setClauses[] = $dialect->quoteId($dbCol) . ' = ' . self::castParam($dialect, $paramIdx, $enumTypeMap, $fieldName);
            $params[] = self::serializeValue($value, $dialect);
            $paramIdx++;
        }

        $idCol = $colMap['id'] ?? 'id';
        $params[] = $recordId;

        $sql = sprintf(
            'UPDATE %s SET %s WHERE %s = %s',
            $dialect->quoteId($dbTable),
            implode(', ', $setClauses),
            $dialect->quoteId($idCol),
            $dialect->param($paramIdx),
        );
        $executor->query($sql, $params);
    }

    // --- Internal helpers ---

    private static function insertOne(
        SQLExecutorInterface $executor,
        DialectInterface $dialect,
        string $dbTable,
        array $colMap,
        array $enumTypeMap,
        array $fields,
    ): array {
        // Generate client-side UUID for 'id' column if not provided
        $idFieldName = self::reverseGet($colMap, self::findIdCol($colMap));
        if ($idFieldName !== null && !isset($fields[$idFieldName])) {
            $fields[$idFieldName] = self::generateUuid();
        }

        if (empty($fields)) {
            $sql = "INSERT INTO {$dialect->quoteId($dbTable)} DEFAULT VALUES RETURNING *";
            return self::mapRowsBack($executor->query($sql), $colMap);
        }

        $dbCols = [];
        $params = [];
        $placeholders = [];
        $paramIdx = 1;

        foreach ($fields as $fieldName => $value) {
            $dbCol = $colMap[$fieldName] ?? $fieldName;
            $dbCols[] = $dialect->quoteId($dbCol);
            $placeholders[] = self::castParam($dialect, $paramIdx, $enumTypeMap, $fieldName);
            $params[] = self::serializeValue($value, $dialect);
            $paramIdx++;
        }

        $colList = implode(', ', $dbCols);
        $valList = implode(', ', $placeholders);

        if ($dialect->supportsReturning()) {
            $sql = "INSERT INTO {$dialect->quoteId($dbTable)} ({$colList}) VALUES ({$valList}) RETURNING *";
            return self::mapRowsBack($executor->query($sql, $params), $colMap);
        }

        // MySQL: INSERT then SELECT back
        $executor->query(
            "INSERT INTO {$dialect->quoteId($dbTable)} ({$colList}) VALUES ({$valList})",
            $params,
        );
        $idCol = self::findIdCol($colMap);
        $recordId = $fields[$idFieldName ?? 'id'] ?? null;
        return self::mapRowsBack(
            $executor->query(
                "SELECT * FROM {$dialect->quoteId($dbTable)} WHERE {$dialect->quoteId($idCol)} = {$dialect->param(1)}",
                [$recordId],
            ),
            $colMap,
        );
    }

    private static function insertBatch(
        SQLExecutorInterface $executor,
        DialectInterface $dialect,
        string $dbTable,
        array $colMap,
        array $enumTypeMap,
        array $fieldsArr,
    ): array {
        if (empty($fieldsArr)) {
            return [];
        }

        // Generate client-side IDs
        $idFieldName = self::reverseGet($colMap, self::findIdCol($colMap));
        if ($idFieldName !== null) {
            $fieldsArr = array_map(function ($f) use ($idFieldName) {
                if (!isset($f[$idFieldName])) {
                    $f[$idFieldName] = self::generateUuid();
                }
                return $f;
            }, $fieldsArr);
        }

        $fieldNames = array_keys($fieldsArr[0]);
        $dbColsList = array_map(fn($f) => $dialect->quoteId($colMap[$f] ?? $f), $fieldNames);
        $colList = implode(', ', $dbColsList);

        // Chunk to stay within bind variable limits (Postgres 32,767)
        $maxParams = 32000;
        $chunkSize = max(1, intdiv($maxParams, count($fieldNames)));
        $allResults = [];

        for ($offset = 0; $offset < count($fieldsArr); $offset += $chunkSize) {
            $chunk = array_slice($fieldsArr, $offset, $chunkSize);
            $params = [];
            $valueTuples = [];
            $paramIdx = 1;

            foreach ($chunk as $fields) {
                $phs = [];
                foreach ($fieldNames as $fn) {
                    $phs[] = self::castParam($dialect, $paramIdx, $enumTypeMap, $fn);
                    $params[] = self::serializeValue($fields[$fn] ?? null, $dialect);
                    $paramIdx++;
                }
                $valueTuples[] = '(' . implode(', ', $phs) . ')';
            }

            $valList = implode(', ', $valueTuples);

            if ($dialect->supportsReturning()) {
                $sql = "INSERT INTO {$dialect->quoteId($dbTable)} ({$colList}) VALUES {$valList} RETURNING *";
                $allResults = array_merge($allResults, self::mapRowsBack($executor->query($sql, $params), $colMap));
            } else {
                $executor->query(
                    "INSERT INTO {$dialect->quoteId($dbTable)} ({$colList}) VALUES {$valList}",
                    $params,
                );
            }
        }

        return $allResults;
    }

    /** @return array<int, array<string, mixed>> */
    private static function mapRowsBack(array $rows, array $colMap): array
    {
        if (empty($colMap)) return $rows;
        $reverse = [];
        foreach ($colMap as $fieldName => $dbCol) {
            $reverse[$dbCol] = $fieldName;
        }
        return array_map(function ($row) use ($reverse) {
            $mapped = [];
            foreach ($row as $k => $v) {
                $mapped[$reverse[$k] ?? $k] = $v;
            }
            return $mapped;
        }, $rows);
    }

    private static function findIdCol(array $colMap): string
    {
        return $colMap['id'] ?? 'id';
    }

    private static function reverseGet(array $mapping, string $dbName): ?string
    {
        foreach ($mapping as $key => $val) {
            if ($val === $dbName) return $key;
        }
        return null;
    }

    private static function castParam(DialectInterface $dialect, int $paramIdx, array $enumTypeMap, string $fieldName): string
    {
        $placeholder = $dialect->param($paramIdx);
        if ($dialect->getName() === 'postgres') {
            $enumType = $enumTypeMap[$fieldName] ?? null;
            if ($enumType !== null) {
                return "{$placeholder}::{$dialect->quoteId($enumType)}";
            }
        }
        return $placeholder;
    }

    private static function serializeValue(mixed $value, DialectInterface $dialect): mixed
    {
        if ($value === null) return $value;

        // JSON: stringify arrays/objects
        if (is_array($value)) {
            return json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        }

        // DateTime objects
        if ($value instanceof \DateTimeInterface) {
            if ($dialect->getName() === 'mysql') {
                return $value->format('Y-m-d H:i:s');
            }
            return $value->format('c');
        }

        // MySQL: convert ISO 8601 datetime strings
        if (is_string($value) && $dialect->getName() === 'mysql') {
            if (preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/', $value)) {
                $converted = str_replace('T', ' ', $value);
                $converted = str_replace('Z', '', $converted);
                $converted = rtrim(rtrim($converted, '0'), '.');
                return $converted;
            }
        }

        return $value;
    }

    private static function generateUuid(): string
    {
        // Generate a v4 UUID
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40); // version 4
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80); // variant 1
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
