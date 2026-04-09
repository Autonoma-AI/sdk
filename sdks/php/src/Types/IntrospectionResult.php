<?php
namespace Autonoma\Sdk\Types;
readonly class IntrospectionResult {
    public function __construct(
        public SchemaInfo $schema,
        public array $tableMap,
        public array $columnMaps,
        public array $enumTypeMaps,
    ) {}
}
