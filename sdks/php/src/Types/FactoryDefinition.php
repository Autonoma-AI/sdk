<?php

namespace Autonoma\Sdk\Types;

class FactoryDefinition
{
    public function __construct(
        /** @var callable(array<string, mixed>, FactoryContext): array<string, mixed> */
        public readonly mixed $create,
        /** @var FieldInfo[] Input field definitions for validation and discover schema */
        public readonly array $inputFields,
        /** @var callable(array<string, mixed>, FactoryContext): void|null */
        public readonly mixed $teardown = null,
    ) {}
}
