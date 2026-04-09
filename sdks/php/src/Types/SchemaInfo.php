<?php
namespace Autonoma\Sdk\Types;
readonly class SchemaInfo {
    /** @param ModelInfo[] $models @param FKEdge[] $edges @param SchemaRelation[] $relations */
    public function __construct(
        public array $models,
        public array $edges,
        public array $relations,
        public string $scopeField,
    ) {}
}
