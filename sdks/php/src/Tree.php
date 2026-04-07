<?php

namespace Autonoma\Sdk;

use Autonoma\Sdk\Types\SchemaInfo;
use Autonoma\Sdk\Types\SchemaRelation;
use Autonoma\Sdk\Types\CreateOp;
use Autonoma\Sdk\Types\DeferredUpdate;
use Autonoma\Sdk\Types\ResolvedTree;

class Tree
{
    private const RESERVED_KEYS = ['_alias', '_ref', '_count', '_batch'];

    /**
     * Convert nested scenario tree into flat, ordered CreateOp list.
     *
     * @param array<string, array<int, array<string, mixed>>> $create
     */
    public static function resolveTree(array $create, SchemaInfo $schema, string $testRunId): ResolvedTree
    {
        /** @var array<string, SchemaRelation> */
        $relationByParentField = [];
        foreach ($schema->relations as $rel) {
            $relationByParentField["{$rel->parentModel}.{$rel->parentField}"] = $rel;
        }

        // Determine FK direction for each relation
        $fkOnParent = [];
        foreach ($schema->relations as $rel) {
            foreach ($schema->edges as $edge) {
                if ($edge->localField === $rel->childField &&
                    ($edge->fromModel === $rel->parentModel || $edge->fromModel === $rel->childModel)) {
                    if ($edge->fromModel === $rel->parentModel) {
                        $fkOnParent["{$rel->parentModel}.{$rel->parentField}"] = true;
                    }
                    break;
                }
            }
        }

        $result = new ResolvedTree();
        $tempCounter = 0;

        $makeTempId = function (string $model) use (&$tempCounter): string {
            return "__temp_{$model}_" . $tempCounter++;
        };

        $walkNode = null;
        $walkNode = function (
            string $modelName,
            array $node,
            ?string $parentTempId,
            ?SchemaRelation $parentRelation,
            bool $parentFkOnParent,
            int $index,
        ) use (&$walkNode, &$result, &$relationByParentField, &$fkOnParent, &$makeTempId, $testRunId, $schema): string {
            $fields = [];
            $preChildren = [];
            $postChildren = [];
            $alias = $node['_alias'] ?? null;
            $tempId = $makeTempId($modelName);

            foreach ($node as $key => $value) {
                if (in_array($key, self::RESERVED_KEYS, true)) {
                    continue;
                }

                // Look up relation
                $exactKey = "{$modelName}.{$key}";
                $lm = lcfirst($modelName);
                $prefixedKey = "{$modelName}.{$lm}" . ucfirst($key);

                $relation = $relationByParentField[$exactKey] ?? $relationByParentField[$prefixedKey] ?? null;
                $matchedKey = isset($relationByParentField[$exactKey]) ? $exactKey : $prefixedKey;

                if ($relation === null) {
                    // Fallback: match by child model name
                    foreach ($relationByParentField as $relKey => $rel) {
                        if (str_starts_with($relKey, "{$modelName}.") &&
                            strtolower($rel->childModel) === strtolower($key)) {
                            $relation = $rel;
                            $matchedKey = $relKey;
                            break;
                        }
                    }
                }

                if ($relation !== null) {
                    $isOnParent = isset($fkOnParent[$matchedKey]);
                    if ($isOnParent) {
                        $preChildren[] = [$relation, $value, true];
                    } else {
                        $postChildren[] = [$relation, $value, false];
                    }
                    continue;
                }

                // Handle _ref
                if (is_array($value) && isset($value['_ref'])) {
                    $refAlias = $value['_ref'];
                    $refTempId = $result->aliases[$refAlias] ?? null;
                    if ($refTempId === null) {
                        $result->deferredUpdates[] = new DeferredUpdate(
                            targetTempId: $tempId,
                            model: $modelName,
                            field: $key,
                            refAlias: $refAlias,
                        );
                        continue;
                    }
                    $fields[$key] = $refTempId;
                    continue;
                }

                $ctx = ['testRunId' => $testRunId, 'index' => $index];
                $fields[$key] = Template::resolveTemplate($value, $ctx);
            }

            // Wire FK to parent
            if ($parentRelation !== null && $parentTempId !== null && !$parentFkOnParent) {
                $fields[$parentRelation->childField] = $parentTempId;
            }

            // Process pre-children (FK on parent side)
            foreach ($preChildren as [$relation, $value, $isOnParent]) {
                if (is_array($value) && !self::isAssoc($value)) {
                    foreach ($value as $i => $childNode) {
                        $childTempId = $walkNode($relation->childModel, $childNode, $tempId, $relation, true, $i);
                        $fields[$relation->childField] = $childTempId;
                    }
                }
            }

            // Create this node
            $result->ops[] = new CreateOp(model: $modelName, fields: $fields, tempId: $tempId, batch: false);
            if ($alias !== null) {
                $result->aliases[$alias] = $tempId;
            }

            // Process post-children (FK on child side)
            foreach ($postChildren as [$relation, $value, $_]) {
                if (is_array($value) && !self::isAssoc($value)) {
                    foreach ($value as $i => $childNode) {
                        $walkNode($relation->childModel, $childNode, $tempId, $relation, false, $i);
                    }
                } elseif (is_array($value) && isset($value['_count'])) {
                    $count = $value['_count'];
                    $isBatch = $value['_batch'] ?? false;

                    for ($i = 0; $i < $count; $i++) {
                        $bulkFields = [];
                        foreach ($value as $k => $v) {
                            if ($k === '_count' || $k === '_batch') continue;
                            $ctx = ['testRunId' => $testRunId, 'index' => $i];
                            $bulkFields[$k] = Template::resolveTemplate($v, $ctx);
                        }
                        $bulkFields[$relation->childField] = $tempId;
                        $result->ops[] = new CreateOp(
                            model: $relation->childModel,
                            fields: $bulkFields,
                            tempId: $makeTempId($relation->childModel),
                            batch: $isBatch,
                        );
                    }
                }
            }

            return $tempId;
        };

        foreach ($create as $modelName => $nodes) {
            foreach ($nodes as $i => $node) {
                $walkNode($modelName, $node, null, null, false, $i);
            }
        }

        return $result;
    }

    private static function isAssoc(array $arr): bool
    {
        if (empty($arr)) return false;
        return array_keys($arr) !== range(0, count($arr) - 1);
    }
}
