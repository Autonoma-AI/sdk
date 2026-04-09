<?php
namespace Autonoma\Sdk\Types;
readonly class HandlerResponse {
    public function __construct(
        public int $status,
        public array $body,
    ) {}
}
