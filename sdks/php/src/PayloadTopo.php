<?php

namespace Autonoma\Sdk;

use Autonoma\Sdk\Types\CreateOp;
use Autonoma\Sdk\Types\ResolvedTree;

/**
 * Resolve the create payload into an ordered list of operations.
 *
 * Ordering comes from the _alias/_ref graph in the create payload.
 * Each entity that others depend on declares `_alias: "name"`.
 * Each entity that depends on another carries `{"_ref": "name"}` somewhere
 * in its field tree. Kahn's topo sort over that graph produces the up order;
 * the reverse is the down order.
 */
class PayloadTopo
{
    private const RESERVED_KEYS = ['_alias', '_ref'];

    /**
     * Walk a field value tree and collect every _ref alias found.
     *
     * @param mixed $value
     * @param string[] &$out
     */
    private static function collectRefs(mixed $value, array &$out): void
    {
        if (is_array($value)) {
            if (isset($value['_ref']) && is_string($value['_ref'])) {
                $out[] = $value['_ref'];
                return;
            }
            foreach ($value as $v) {
                self::collectRefs($v, $out);
            }
        }
    }

    /**
     * Replace each {"_ref": alias} with its temp id.
     */
    private static function resolveRefs(mixed $value, array $aliasToTempId): mixed
    {
        if (is_array($value)) {
            if (isset($value['_ref']) && is_string($value['_ref'])) {
                $real = $aliasToTempId[$value['_ref']] ?? null;
                return $real !== null ? $real : $value;
            }
            $result = [];
            foreach ($value as $k => $v) {
                $result[$k] = self::resolveRefs($v, $aliasToTempId);
            }
            return $result;
        }
        return $value;
    }

    /**
     * Topo-sort a create payload into an ordered list of CreateOp.
     *
     * @param array<string, array<int, array<string, mixed>>> $create
     */
    public static function resolvePayloadTree(array $create): ResolvedTree
    {
        if (!is_array($create)) {
            throw AutonomaError::invalidBody('`create` must be an object keyed by model name');
        }

        // First pass: assign temp ids and collect alias declarations.
        /** @var array<int, array{string, string, array, ?string}> $rawEntries */
        $rawEntries = [];
        $counter = 0;
        $aliases = [];
        $aliasOwnerModel = [];

        foreach ($create as $model => $entities) {
            if (!is_array($entities) || !array_is_list($entities)) {
                throw AutonomaError::invalidBody("`create.{$model}` must be a list of entity objects");
            }
            foreach ($entities as $entity) {
                if (!is_array($entity)) {
                    throw AutonomaError::invalidBody("`create.{$model}` entries must be objects");
                }
                $tempId = "__temp_{$model}_{$counter}";
                $counter++;
                $alias = $entity['_alias'] ?? null;
                if (is_string($alias)) {
                    if (isset($aliases[$alias])) {
                        throw AutonomaError::invalidBody("duplicate _alias \"{$alias}\"");
                    }
                    $aliases[$alias] = $tempId;
                    $aliasOwnerModel[$alias] = $model;
                } elseif ($alias !== null) {
                    throw AutonomaError::invalidBody('"_alias" must be a string');
                }
                $rawEntries[] = [$model, $tempId, $entity, is_string($alias) ? $alias : null];
            }
        }

        // Second pass: collect dependencies and strip reserved keys.
        $depsByTempId = [];
        $fieldsByTempId = [];
        $modelByTempId = [];
        $aliasByTempId = [];

        foreach ($rawEntries as [$model, $tempId, $entity, $alias]) {
            $deps = [];
            $cleaned = [];
            foreach ($entity as $key => $value) {
                if (in_array($key, self::RESERVED_KEYS, true)) {
                    continue;
                }
                self::collectRefs($value, $deps);
                $cleaned[$key] = self::resolveRefs($value, $aliases);
            }
            $unknown = array_diff($deps, array_keys($aliases));
            if (!empty($unknown)) {
                $unknownList = implode(', ', array_unique($unknown));
                throw AutonomaError::invalidBody("`create.{$model}` references unknown alias(es): {$unknownList}");
            }
            $depsByTempId[$tempId] = $deps;
            $fieldsByTempId[$tempId] = $cleaned;
            $modelByTempId[$tempId] = $model;
            $aliasByTempId[$tempId] = $alias;
        }

        // Build the temp_id graph and topo-sort.
        $inDegree = [];
        $payloadOrder = [];
        foreach ($rawEntries as $idx => [$_model, $tempId, $_entity, $_alias]) {
            $inDegree[$tempId] = 0;
            $payloadOrder[$tempId] = $idx;
        }

        $edges = [];
        foreach ($depsByTempId as $tempId => $deps) {
            $seen = [];
            foreach ($deps as $depAlias) {
                $depTempId = $aliases[$depAlias];
                if ($depTempId === $tempId || isset($seen[$depTempId])) {
                    continue;
                }
                $seen[$depTempId] = true;
                $edges[$depTempId][] = $tempId;
                $inDegree[$tempId]++;
            }
        }

        // Kahn's, preserving payload order as the stable tie-breaker.
        $ready = [];
        foreach ($inDegree as $tid => $deg) {
            if ($deg === 0) {
                $ready[] = $tid;
            }
        }
        usort($ready, fn($a, $b) => $payloadOrder[$a] <=> $payloadOrder[$b]);

        $sortedTempIds = [];
        while (!empty($ready)) {
            $tid = array_shift($ready);
            $sortedTempIds[] = $tid;
            foreach ($edges[$tid] ?? [] as $nxt) {
                $inDegree[$nxt]--;
                if ($inDegree[$nxt] === 0) {
                    $ready[] = $nxt;
                }
            }
            usort($ready, fn($a, $b) => $payloadOrder[$a] <=> $payloadOrder[$b]);
        }

        if (count($sortedTempIds) !== count($payloadOrder)) {
            $cycle = [];
            foreach ($inDegree as $tid => $deg) {
                if ($deg > 0) {
                    $cycle[] = $tid;
                }
            }
            usort($cycle, fn($a, $b) => $payloadOrder[$a] <=> $payloadOrder[$b]);
            $cycleModels = implode(', ', array_map(fn($t) => $modelByTempId[$t], $cycle));
            throw AutonomaError::invalidBody("cycle detected in _alias/_ref graph: {$cycleModels}");
        }

        // Build CreateOp list in topo order.
        $tree = new ResolvedTree();
        $tree->aliases = $aliases;
        $tree->aliasOwnerModel = $aliasOwnerModel;
        $tree->aliasDependencies = [];
        foreach ($aliases as $alias => $aliasTempId) {
            $tree->aliasDependencies[$alias] = $depsByTempId[$aliasTempId] ?? [];
        }

        foreach ($sortedTempIds as $tid) {
            $tree->ops[] = new CreateOp(
                model: $modelByTempId[$tid],
                fields: $fieldsByTempId[$tid],
                tempId: $tid,
            );
        }

        return $tree;
    }

    /**
     * Order models for teardown.
     *
     * With aliasDependencies available (newer refs tokens), runs Kahn's topo
     * sort over models and returns the reverse so children are torn down
     * before parents.
     *
     * Without it (older tokens), falls back to reversing the refs key order.
     *
     * @param array<string, array> $refs
     * @param array<string, string[]>|null $aliasDependencies
     * @param array<string, string>|null $aliasOwnerModel
     * @return string[]
     */
    public static function computeTeardownOrder(
        array $refs,
        ?array $aliasDependencies,
        ?array $aliasOwnerModel,
    ): array {
        $models = array_keys($refs);

        if (empty($aliasDependencies) || empty($aliasOwnerModel)) {
            return array_reverse($models);
        }

        // Build model->{model dependencies} by aggregating per-alias edges.
        $modelDeps = [];
        foreach ($models as $m) {
            $modelDeps[$m] = [];
        }

        foreach ($aliasDependencies as $alias => $deps) {
            $owner = $aliasOwnerModel[$alias] ?? null;
            if ($owner === null || !isset($modelDeps[$owner])) {
                continue;
            }
            foreach ($deps as $depAlias) {
                $depModel = $aliasOwnerModel[$depAlias] ?? null;
                if ($depModel === null || $depModel === $owner) {
                    continue;
                }
                if (isset($modelDeps[$depModel])) {
                    $modelDeps[$owner][$depModel] = true;
                }
            }
        }

        // Kahn's over models.
        $inDegree = [];
        $adj = [];
        foreach ($models as $m) {
            $inDegree[$m] = 0;
        }
        foreach ($modelDeps as $owner => $deps) {
            foreach ($deps as $depModel => $_) {
                $adj[$depModel][] = $owner;
                $inDegree[$owner]++;
            }
        }

        $payloadOrder = array_flip($models);
        $ready = [];
        foreach ($inDegree as $m => $d) {
            if ($d === 0) {
                $ready[] = $m;
            }
        }
        usort($ready, fn($a, $b) => $payloadOrder[$a] <=> $payloadOrder[$b]);

        $upOrder = [];
        while (!empty($ready)) {
            $m = array_shift($ready);
            $upOrder[] = $m;
            foreach ($adj[$m] ?? [] as $nxt) {
                $inDegree[$nxt]--;
                if ($inDegree[$nxt] === 0) {
                    $ready[] = $nxt;
                }
            }
            usort($ready, fn($a, $b) => $payloadOrder[$a] <=> $payloadOrder[$b]);
        }

        if (count($upOrder) !== count($models)) {
            // Cycle shouldn't happen (rejected at up). Fall back to reverse insertion order.
            return array_reverse($models);
        }

        return array_reverse($upOrder);
    }
}
