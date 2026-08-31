<?php

namespace Autonoma\Sdk\Types;

/**
 * Factory definition - part of the optional factory helper library. Factories
 * are NOT wired to the wire protocol in v2; a scenario's up/down may use them
 * internally to create and tear down entities through the app's real logic.
 */
class FactoryDefinition
{
    public function __construct(
        /** @var callable(array<string, mixed>, FactoryContext): array<string, mixed> */
        public readonly mixed $create,
        /** @var callable(array<string, mixed>, FactoryContext): void|null */
        public readonly mixed $teardown = null,
        /** @var array<int, array<string, mixed>> Optional field declarations for the host's own validation. */
        public readonly array $inputFields = [],
    ) {}
}
