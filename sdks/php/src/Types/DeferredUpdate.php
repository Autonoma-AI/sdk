<?php
namespace Autonoma\Sdk\Types;
readonly class DeferredUpdate {
    public function __construct(
        public string $targetTempId,
        public string $model,
        public string $field,
        public string $refAlias,
    ) {}
}
