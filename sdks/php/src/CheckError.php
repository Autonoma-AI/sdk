<?php

namespace Autonoma\Sdk;

class CheckError
{
    public function __construct(
        public readonly string $phase,
        public readonly string $message,
        public readonly string $fix = '',
    ) {}
}
