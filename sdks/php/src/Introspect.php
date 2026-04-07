<?php

namespace Autonoma\Sdk;

use Autonoma\Sdk\Dialect\DialectInterface;
use Autonoma\Sdk\Types\SQLExecutorInterface;
use Autonoma\Sdk\Types\IntrospectionResult;
use Autonoma\Sdk\Types\SchemaInfo;
use Autonoma\Sdk\Types\ModelInfo;
use Autonoma\Sdk\Types\FieldInfo;
use Autonoma\Sdk\Types\FKEdge;
use Autonoma\Sdk\Types\SchemaRelation;

class Introspect
{
    public static function introspectDatabase(
        SQLExecutorInterface $executor,
        DialectInterface $dialect,
        string $scopeField,
        ?string $schema = null,
        ?array $tableNameMap = null,
        ?array $excludeTables = null,
    ): IntrospectionResult {
        $dbSchema = $schema ?? ($dialect->getName() !== 'mysql' ? 'public' : null);
        if ($dbSchema === null) {
            throw new \InvalidArgumentException('MySQL requires a schema (database name). Pass it via dbSchema or HandlerConfig.dbSchema.');
        }

        $excludeSet = array_flip($excludeTables ?? ['_prisma_migrations']);

        // Run introspection queries
        $tableRows = $executor->query($dialect->tablesSql($dbSchema));
        $columnRows = $executor->query($dialect->columnsSql($dbSchema));
        $pkRows = $executor->query($dialect->primaryKeysSql($dbSchema));
        $fkRows = $executor->query($dialect->foreignKeysSql($dbSchema));
        $enumRows = $executor->query($dialect->enumsSql($dbSchema));

        // Normalize keys to lowercase
        $tableRows = self::normalizeKeys($tableRows);
        $columnRows = self::normalizeKeys($columnRows);
        $pkRows = self::normalizeKeys($pkRows);
        $fkRows = self::normalizeKeys($fkRows);
        $enumRows = self::normalizeKeys($enumRows);

        // Build enum lookup
        $enumValues = [];
        foreach ($enumRows as $row) {
            $name = $row['enum_name'] ?? null;
            if ($name === null) continue;
            $enumValues[$name][] = $row['enum_value'];
        }

        // MySQL: parse inline enums from column_type
        if ($dialect->getName() === 'mysql') {
            foreach ($columnRows as $col) {
                $parsed = self::parseMysqlEnum($col['udt_name'] ?? '');
                if ($parsed !== null) {
                    $key = $col['table_name'] . '.' . $col['column_name'];
                    $enumValues[$key] = $parsed;
                }
            }
        }

        // Build PK lookup
        $pksByTable = [];
        foreach ($pkRows as $row) {
            $pksByTable[$row['table_name']][$row['column_name']] = true;
        }

        // Build table name mapping
        $userMap = $tableNameMap ?? [];
        $tableMap = [];
        $reverseTableMap = [];

        foreach ($userMap as $model => $dbTable) {
            $tableMap[$model] = $dbTable;
            $reverseTableMap[$dbTable] = $model;
        }

        $dbTables = [];
        foreach ($tableRows as $r) {
            if (!isset($excludeSet[$r['table_name']])) {
                $dbTables[] = $r['table_name'];
            }
        }

        foreach ($dbTables as $dbTable) {
            if (isset($reverseTableMap[$dbTable])) continue;
            $modelName = self::snakeToPascal($dbTable);
            $tableMap[$modelName] = $dbTable;
            $reverseTableMap[$dbTable] = $modelName;
        }

        // Group columns by table
        $columnsByTable = [];
        foreach ($columnRows as $row) {
            $columnsByTable[$row['table_name']][] = $row;
        }

        // Build models and column maps
        $models = [];
        $columnMaps = [];
        $enumTypeMaps = [];

        foreach ($tableMap as $modelName => $dbTable) {
            $cols = $columnsByTable[$dbTable] ?? [];
            $pks = $pksByTable[$dbTable] ?? [];
            $colMap = [];
            $fields = [];

            foreach ($cols as $col) {
                $fieldName = self::snakeToCamel($col['column_name']);
                $colMap[$fieldName] = $col['column_name'];

                // Check for enums
                $enumVals = null;
                if ($dialect->getName() === 'mysql') {
                    $enumVals = $enumValues[$col['table_name'] . '.' . $col['column_name']] ?? null;
                } else {
                    $enumVals = $enumValues[$col['udt_name'] ?? ''] ?? null;
                }

                if ($enumVals !== null) {
                    $fieldType = 'enum(' . implode(',', $enumVals) . ')';
                } else {
                    $fieldType = self::mapDataType($col['data_type'], $col['udt_name'] ?? '', $dialect->getName());
                }

                // Track Postgres types needing casts
                if ($dialect->getName() === 'postgres') {
                    if ($enumVals !== null) {
                        $enumTypeMaps[$modelName][$fieldName] = $col['udt_name'] ?? '';
                    } elseif (in_array($col['data_type'], ['jsonb', 'json']) || in_array($col['udt_name'] ?? '', ['jsonb', 'json'])) {
                        $jsonType = ($col['data_type'] === 'json' || ($col['udt_name'] ?? '') === 'json') ? 'json' : 'jsonb';
                        $enumTypeMaps[$modelName][$fieldName] = $jsonType;
                    } elseif (str_contains($col['data_type'], 'timestamp') || in_array($col['udt_name'] ?? '', ['timestamptz', 'timestamp'])) {
                        $enumTypeMaps[$modelName][$fieldName] = $col['udt_name'] ?? '';
                    }
                }

                $fields[] = new FieldInfo(
                    name: $fieldName,
                    type: $fieldType,
                    isRequired: $col['is_nullable'] === 'NO',
                    isId: isset($pks[$col['column_name']]),
                    hasDefault: $col['column_default'] !== null,
                );
            }

            $columnMaps[$modelName] = $colMap;
            $models[] = new ModelInfo(name: $modelName, fields: $fields);
        }

        // Build FK edges
        $edges = [];
        foreach ($fkRows as $fk) {
            $fromModel = $reverseTableMap[$fk['from_table']] ?? null;
            $toModel = $reverseTableMap[$fk['to_table']] ?? null;
            if ($fromModel === null || $toModel === null) continue;

            $fromColMap = $columnMaps[$fromModel] ?? [];
            $toColMap = $columnMaps[$toModel] ?? [];
            $localField = self::reverseGet($fromColMap, $fk['from_column']) ?? $fk['from_column'];
            $foreignField = self::reverseGet($toColMap, $fk['to_column']) ?? $fk['to_column'];

            $edges[] = new FKEdge(
                fromModel: $fromModel,
                toModel: $toModel,
                localField: $localField,
                foreignField: $foreignField,
                nullable: $fk['is_nullable'] === 'YES',
            );
        }

        // Build relations from FK edges
        $relations = [];
        foreach ($edges as $edge) {
            $fromDbTable = $tableMap[$edge->fromModel] ?? '';
            $fromColMap = $columnMaps[$edge->fromModel] ?? [];
            $fkDbCol = $fromColMap[$edge->localField] ?? $edge->localField;
            $fromPks = $pksByTable[$fromDbTable] ?? [];
            $isOneToOne = count($fromPks) === 1 && isset($fromPks[$fkDbCol]);

            // Parent-side
            $relations[] = new SchemaRelation(
                parentModel: $edge->toModel,
                childModel: $edge->fromModel,
                parentField: $isOneToOne ? self::lowerFirst($edge->fromModel) : self::pluralCamelCase($edge->fromModel),
                childField: $edge->localField,
            );

            // Child-side
            $relations[] = new SchemaRelation(
                parentModel: $edge->fromModel,
                childModel: $edge->toModel,
                parentField: self::lowerFirst($edge->toModel),
                childField: $edge->localField,
            );
        }

        $schemaInfo = new SchemaInfo(
            models: $models,
            edges: $edges,
            relations: $relations,
            scopeField: $scopeField,
        );

        return new IntrospectionResult(
            schema: $schemaInfo,
            tableMap: $tableMap,
            columnMaps: $columnMaps,
            enumTypeMaps: $enumTypeMaps,
        );
    }

    // --- Name mapping utilities ---

    public static function snakeToPascal(string $s): string
    {
        return implode('', array_map(fn($part) => ucfirst($part), array_filter(explode('_', $s))));
    }

    public static function snakeToCamel(string $s): string
    {
        $pascal = self::snakeToPascal($s);
        return $pascal === '' ? '' : lcfirst($pascal);
    }

    private static function lowerFirst(string $s): string
    {
        return $s === '' ? '' : lcfirst($s);
    }

    private static function pluralCamelCase(string $modelName): string
    {
        $camel = self::lowerFirst($modelName);
        return self::pluralize($camel);
    }

    private static function pluralize(string $s): string
    {
        if (preg_match('/(s|x|z|ch|sh)$/', $s)) return $s . 'es';
        if (preg_match('/[^aeiou]y$/', $s) && strlen($s) > 1) return substr($s, 0, -1) . 'ies';
        return $s . 's';
    }

    private static function parseMysqlEnum(string $columnType): ?array
    {
        if ($columnType === '') return null;
        if (!preg_match('/^enum\((.+)\)$/i', $columnType, $m)) return null;
        return array_map(fn($v) => trim(trim($v), "'"), explode(',', $m[1]));
    }

    private static function mapDataType(string $dataType, string $udtName, string $dialectName): string
    {
        $dt = strtolower($dataType);
        if (in_array($dt, ['integer', 'smallint', 'bigint', 'int', 'mediumint', 'tinyint'])) return 'Int';
        if (in_array($dt, ['numeric', 'real', 'double precision', 'float', 'double', 'decimal'])) return 'Float';
        if ($dt === 'boolean' || $dt === 'tinyint(1)') return 'Boolean';
        if (in_array($dt, ['text', 'character varying', 'character', 'varchar', 'char', 'mediumtext', 'longtext', 'tinytext'])) return 'String';
        if (in_array($dt, ['timestamp with time zone', 'timestamp without time zone', 'date', 'time', 'datetime', 'timestamp'])) return 'DateTime';
        if (in_array($dt, ['json', 'jsonb'])) return 'Json';
        if ($dt === 'uuid') return 'String';
        if (in_array($dt, ['bytea', 'blob', 'mediumblob', 'longblob', 'tinyblob', 'binary', 'varbinary'])) return 'Bytes';
        if ($dt === 'user-defined' && $dialectName === 'postgres') return $udtName;
        if (in_array($dt, ['enum', 'set'])) return $udtName;
        return $dataType;
    }

    /** @param array<string, string> $mapping */
    private static function reverseGet(array $mapping, string $dbName): ?string
    {
        foreach ($mapping as $key => $val) {
            if ($val === $dbName) return $key;
        }
        return null;
    }

    /** @param array<int, array<string, mixed>> $rows */
    private static function normalizeKeys(array $rows): array
    {
        return array_map(fn($row) => array_change_key_case($row, CASE_LOWER), $rows);
    }
}
