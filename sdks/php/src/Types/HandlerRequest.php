<?php
namespace Autonoma\Sdk\Types;
readonly class HandlerRequest {
    public function __construct(
        public string $body,
        public array $headers = [],
    ) {}
}
