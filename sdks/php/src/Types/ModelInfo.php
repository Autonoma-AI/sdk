<?php
namespace Autonoma\Sdk\Types;
readonly class ModelInfo {
    /** @param FieldInfo[] $fields */
    public function __construct(
        public string $name,
        public array $fields,
    ) {}
}
