<?php

namespace Autonoma\Sdk;

class CheckResult
{
    public function __construct(
        public readonly bool $valid,
        public readonly string $phase,
        public readonly array $errors = [],
        public readonly ?array $timing = null,
    ) {}
}
