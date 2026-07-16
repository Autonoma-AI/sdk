<?php

namespace Autonoma\Sdk\Types;

class HandlerConfig
{
    public function __construct(
        public readonly string $scopeField,
        public readonly string $sharedSecret,
        public readonly string $signingSecret,
        /** @var callable(?array, array): array */
        public readonly mixed $auth,
        /** @var array<string, FactoryDefinition> Factory definitions per model */
        public readonly array $factories = [],
        /**
         * @deprecated Ignored; the endpoint is always enabled and HMAC signing is the gate.
         * On Autonoma previews (AUTONOMA_PREVIEWKIT set) no guard is needed; gate manually
         * in your handler for your own production deployments.
         */
        public readonly bool $allowProduction = false,
        public /*readonly*/ ?array $sdk = null,
        /** @var callable(array{scenarioName: string, refs: array}): void|null */
        public readonly mixed $beforeDown = null,
        /** @var callable(array{scenarioName: string, refs: array}, array): array|null */
        public readonly mixed $afterUp = null,
    ) {}
}
