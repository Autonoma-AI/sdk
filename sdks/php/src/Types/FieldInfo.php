<?php
namespace Autonoma\Sdk\Types;
readonly class FieldInfo {
    public function __construct(
        public string $name,
        public string $type,
        public bool $isRequired,
        public bool $isId,
        public bool $hasDefault,
    ) {}
}
