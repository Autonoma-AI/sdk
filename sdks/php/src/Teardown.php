<?php

namespace Autonoma\Sdk;

use Autonoma\Sdk\Dialect\DialectInterface;
use Autonoma\Sdk\Types\SQLExecutorInterface;
use Autonoma\Sdk\Types\SchemaInfo;

class Teardown
{
    /**
     * Compute the teardown order for models (reverse topological order).
     * Returns the order, scope root model, cycles, and scope field map.
     *
     * @return array{order: string[], scopeRootModel: string|null, cycles: array[], scopeFieldByModel: array<string, string>}
     */
    public static function computeTeardownOrder(SchemaInfo $schema): array
    {
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

        // Build map: model -> FK field pointing to scope root
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

        // Build condensation graph
        $components = [];
        $nodeToComp = [];

        foreach ($cycles as $cycle) {
            $idx = count($components);
            $components[] = $cycle;
            foreach ($cycle as $node) {
                $nodeToComp[$node] = $idx;
            }
        }
        foreach ($sortedModels as $node) {
            $nodeToComp[$node] = count($components);
            $components[] = [$node];
        }

        // Build condensation DAG edges
        $condAdj = [];
        $condInDeg = [];
        for ($i = 0; $i < count($components); $i++) {
            $condAdj[$i] = [];
            $condInDeg[$i] = 0;
        }
        foreach ($schema->edges as $edge) {
            if ($edge->fromModel === $edge->toModel) continue;
            $fc = $nodeToComp[$edge->fromModel] ?? null;
            $tc = $nodeToComp[$edge->toModel] ?? null;
            if ($fc !== null && $tc !== null && $fc !== $tc && !isset($condAdj[$tc][$fc])) {
                $condAdj[$tc][$fc] = true;
                $condInDeg[$fc]++;
            }
        }

        // Kahn's algorithm on the condensation DAG
        $condQueue = [];
        foreach ($condInDeg as $idx => $deg) {
            if ($deg === 0) $condQueue[] = $idx;
        }
        sort($condQueue);
        $condOrder = [];
        while (!empty($condQueue)) {
            sort($condQueue);
            $idx = array_shift($condQueue);
            $condOrder[] = $idx;
            foreach (array_keys($condAdj[$idx]) as $neighbor) {
                $condInDeg[$neighbor]--;
                if ($condInDeg[$neighbor] === 0) {
                    $condQueue[] = $neighbor;
                }
            }
        }

        // Flatten in reverse condensation order, excluding scope root
        $order = [];
        foreach (array_reverse($condOrder) as $compIdx) {
            foreach ($components[$compIdx] as $model) {
                if ($model !== $scopeRootModel) {
                    $order[] = $model;
                }
            }
        }

        return [
            'order' => $order,
            'scopeRootModel' => $scopeRootModel,
            'cycles' => $cycles,
            'scopeFieldByModel' => $scopeFieldByModel,
        ];
    }

    /**
     * Delete all data scoped to scopeValue in reverse topological order.
     *
     * @param string[] $skipModels Models to skip (handled by factory teardown)
     */
    public static function teardown(
        SQLExecutorInterface $executor,
        DialectInterface $dialect,
        array $tableMap,
        array $columnMaps,
        SchemaInfo $schema,
        string $scopeValue,
        ?array $refs = null,
        array $skipModels = [],
    ): void {
        $teardownInfo = self::computeTeardownOrder($schema);
        $order = $teardownInfo['order'];
        $scopeRootModel = $teardownInfo['scopeRootModel'];
        $cycles = $teardownInfo['cycles'];
        $scopeFieldByModel = $teardownInfo['scopeFieldByModel'];

        // Convert edges to dict format for findDeferrableEdge
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

        $executor->transaction(function (SQLExecutorInterface $tx) use (
            $dialect, $tableMap, $columnMaps, $scopeRootModel,
            $scopeFieldByModel, $order, $cycles, $edgeDicts,
            $scopeValue, $refs, $schema, $skipModels,
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

            // Delete in reverse condensation order (dependents first), skipping factory-teardown models
            foreach ($order as $model) {
                if (in_array($model, $skipModels, true)) continue;
                self::deleteModel(
                    $tx, $dialect, $tableMap, $columnMaps, $model,
                    $scopeValue, $scopeFieldByModel, $refs, $schema,
                );
            }

            // Delete scope root last (unless skipped by factory teardown)
            if ($scopeRootModel === null || in_array($scopeRootModel, $skipModels, true)) {
                return;
            }

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
