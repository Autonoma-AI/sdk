<?php
namespace Autonoma\Sdk\Types;
readonly class FKEdge {
    public function __construct(
        public string $fromModel,
        public string $toModel,
        public string $localField,
        public string $foreignField,
        public bool $nullable,
    ) {}
}
