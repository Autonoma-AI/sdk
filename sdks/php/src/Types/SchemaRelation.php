<?php
namespace Autonoma\Sdk\Types;
readonly class SchemaRelation {
    public function __construct(
        public string $parentModel,
        public string $childModel,
        public string $parentField,
        public string $childField,
    ) {}
}
