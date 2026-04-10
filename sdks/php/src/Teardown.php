<?php

namespace Autonoma\Sdk;

use Autonoma\Sdk\Dialect\DialectInterface;
use Autonoma\Sdk\Types\SQLExecutorInterface;
use Autonoma\Sdk\Types\SchemaInfo;

class Teardown
{
    /**
     * Delete all data scoped to scopeValue in reverse topological order.
     */
    public static function teardown(
        SQLExecutorInterface $executor,
        DialectInterface $dialect,
        array $tableMap,
        array $columnMaps,
        SchemaInfo $schema,
        string $scopeValue,
        ?array $refs = null,
    ): void {
        // Convert edges to dict format for graph module
        $edgeDicts = [];
        foreach ($schema->edges as $e) {
            $edgeDicts[] = [
                'from' => $e->fromModel,
                'to' => $e->toModel,
                'localField' => $e->localField,
                'foreignField' => $e->foreignField,
                'nullable' => $e->nullable,
            ];
        }

        // Find scope root model
        $scopeRootModel = null;
        foreach ($schema->edges as $edge) {
            if (strtolower($edge->localField) === strtolower($schema->scopeField) &&
                $edge->toModel !== $edge->fromModel) {
                $scopeRootModel = $edge->toModel;
                break;
            }
        }

        // Build map: model → FK field pointing to scope root
        $scopeFieldByModel = [];
        if ($scopeRootModel !== null) {
            foreach ($schema->edges as $edge) {
                if ($edge->toModel === $scopeRootModel && $edge->fromModel !== $scopeRootModel) {
                    $scopeFieldByModel[$edge->fromModel] = $edge->localField;
                }
            }
        }

        $modelNames = array_map(fn($m) => $m->name, $schema->models);
        $result = Graph::topoSort($modelNames, $edgeDicts);
        $sortedModels = $result['sorted'];
        $cycles = $result['cycles'];

        $executor->transaction(function (SQLExecutorInterface $tx) use (
            $dialect, $tableMap, $columnMaps, $scopeRootModel,
            $scopeFieldByModel, $sortedModels, $cycles, $edgeDicts,
            $scopeValue, $refs, $schema,
        ) {
            // Break cycles by nullifying deferrable FKs
            foreach ($cycles as $cycle) {
                $edge = Graph::findDeferrableEdge($cycle, $edgeDicts);
                if ($edge !== null) {
                    $scopeFk = $scopeFieldByModel[$edge['from']] ?? null;
                    if ($scopeFk !== null) {
                        $dbTable = $tableMap[$edge['from']] ?? null;
                        $colMap = $columnMaps[$edge['from']] ?? [];
                        if ($dbTable !== null) {
                            $dbFkCol = $colMap[$edge['localField']] ?? $edge['localField'];
                            $dbScopeCol = $colMap[$scopeFk] ?? $scopeFk;
                            $tx->query(
                                sprintf(
                                    'UPDATE %s SET %s = NULL WHERE %s = %s',
                                    $dialect->quoteId($dbTable),
                                    $dialect->quoteId($dbFkCol),
                                    $dialect->quoteId($dbScopeCol),
                                    $dialect->param(1),
                                ),
                                [$scopeValue],
                            );
                        }
                    }
                }
            }

            // Partition sorted nodes: those that depend on cycle nodes must be deleted
            // BEFORE cycles, those that cycle nodes depend on must be deleted AFTER.
            $cycleNodeSet = [];
            foreach ($cycles as $cycle) {
                foreach ($cycle as $n) {
                    $cycleNodeSet[$n] = true;
                }
            }

            if (!empty($cycleNodeSet)) {
                // Build dependency map: node → set of nodes it depends on
                $dependsOn = [];
                foreach ($schema->edges as $edge) {
                    if ($edge->from !== $edge->to) {
                        $dependsOn[$edge->from][$edge->to] = true;
                    }
                }

                // Mark nodes that transitively depend on cycle nodes
                $dependsOnCycle = [];
                foreach ($sortedModels as $node) {
                    $deps = $dependsOn[$node] ?? [];
                    foreach ($deps as $dep => $_) {
                        if (isset($cycleNodeSet[$dep]) || isset($dependsOnCycle[$dep])) {
                            $dependsOnCycle[$node] = true;
                            break;
                        }
                    }
                }

                $cycleDependents = array_filter($sortedModels, fn($n) => isset($dependsOnCycle[$n]));
                $cycleDeps = array_filter($sortedModels, fn($n) => !isset($dependsOnCycle[$n]));

                foreach (array_reverse(array_values($cycleDependents)) as $model) {
                    if ($model === $scopeRootModel) continue;
                    self::deleteModel(
                        $tx, $dialect, $tableMap, $columnMaps, $model,
                        $scopeValue, $scopeFieldByModel, $refs, $schema,
                    );
                }

                foreach ($cycles as $cycle) {
                    foreach ($cycle as $model) {
                        self::deleteModel(
                            $tx, $dialect, $tableMap, $columnMaps, $model,
                            $scopeValue, $scopeFieldByModel, $refs, $schema,
                        );
                    }
                }

                foreach (array_reverse(array_values($cycleDeps)) as $model) {
                    if ($model === $scopeRootModel) continue;
                    self::deleteModel(
                        $tx, $dialect, $tableMap, $columnMaps, $model,
                        $scopeValue, $scopeFieldByModel, $refs, $schema,
                    );
                }
            } else {
                foreach (array_reverse($sortedModels) as $model) {
                    if ($model === $scopeRootModel) continue;
                    self::deleteModel(
                        $tx, $dialect, $tableMap, $columnMaps, $model,
                        $scopeValue, $scopeFieldByModel, $refs, $schema,
                    );
                }
            }

            // Delete scope root last
            if ($scopeRootModel !== null) {
                $dbTable = $tableMap[$scopeRootModel] ?? null;
                $colMap = $columnMaps[$scopeRootModel] ?? [];
                if ($dbTable !== null) {
                    // Find PK field name for scope root model
                    $rootModelInfo = null;
                    foreach ($schema->models as $m) {
                        if ($m->name === $scopeRootModel) {
                            $rootModelInfo = $m;
                            break;
                        }
                    }
                    // Composite PK: prefer field named "id"
                    $rootIdFields = [];
                    if ($rootModelInfo !== null) {
                        foreach ($rootModelInfo->fields as $f) {
                            if ($f->isId) {
                                $rootIdFields[] = $f;
                            }
                        }
                    }
                    $rootPkField = null;
                    foreach ($rootIdFields as $f) {
                        if (strtolower($f->name) === 'id') {
                            $rootPkField = $f;
                            break;
                        }
                    }
                    if ($rootPkField === null) {
                        $rootPkField = $rootIdFields[0] ?? null;
                    }
                    $rootPkFieldName = $rootPkField !== null ? $rootPkField->name : 'id';
                    $idCol = $colMap[$rootPkFieldName] ?? $rootPkFieldName;
                    $tx->query(
                        sprintf(
                            'DELETE FROM %s WHERE %s = %s',
                            $dialect->quoteId($dbTable),
                            $dialect->quoteId($idCol),
                            $dialect->param(1),
                        ),
                        [$scopeValue],
                    );
                }
            }
        });
    }

    private static function deleteModel(
        SQLExecutorInterface $tx,
        DialectInterface $dialect,
        array $tableMap,
        array $columnMaps,
        string $model,
        string $scopeValue,
        array $scopeFieldByModel,
        ?array $refs,
        SchemaInfo $schema,
    ): void {
        $dbTable = $tableMap[$model] ?? null;
        if ($dbTable === null) return;
        $colMap = $columnMaps[$model] ?? [];

        // Find actual PK field name from schema
        $modelInfo = null;
        foreach ($schema->models as $m) {
            if ($m->name === $model) {
                $modelInfo = $m;
                break;
            }
        }
        // When multiple isId fields exist (composite PK), prefer the one named "id"
        $idFields = [];
        if ($modelInfo !== null) {
            foreach ($modelInfo->fields as $f) {
                if ($f->isId) {
                    $idFields[] = $f;
                }
            }
        }
        $pkField = null;
        foreach ($idFields as $f) {
            if (strtolower($f->name) === 'id') {
                $pkField = $f;
                break;
            }
        }
        $pkFieldName = $pkField !== null ? $pkField->name : ($idFields[0]->name ?? 'id');

        $scopeFk = $scopeFieldByModel[$model] ?? null;
        if ($scopeFk !== null) {
            $dbCol = $colMap[$scopeFk] ?? $scopeFk;
            $tx->query(
                sprintf(
                    'DELETE FROM %s WHERE %s = %s',
                    $dialect->quoteId($dbTable),
                    $dialect->quoteId($dbCol),
                    $dialect->param(1),
                ),
                [$scopeValue],
            );
        } elseif ($refs !== null && isset($refs[$model])) {
            $ids = [];
            foreach ($refs[$model] as $r) {
                $id = $r[$pkFieldName] ?? null;
                if ($id !== null) {
                    $ids[] = $id;
                }
            }
            if (!empty($ids)) {
                $idCol = $colMap[$pkFieldName] ?? $pkFieldName;
                $placeholders = implode(', ', array_map(fn($i) => $dialect->param($i + 1), range(0, count($ids) - 1)));
                $tx->query(
                    sprintf(
                        'DELETE FROM %s WHERE %s IN (%s)',
                        $dialect->quoteId($dbTable),
                        $dialect->quoteId($idCol),
                        $placeholders,
                    ),
                    $ids,
                );
            }
        }
    }
}
