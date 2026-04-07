<?php
namespace Autonoma\Sdk\Types;
readonly class CreateOp {
    public function __construct(
        public string $model,
        public array $fields,
        public string $tempId,
        public bool $batch,
    ) {}
}
