<?php
namespace Autonoma\Sdk\Types;
class HandlerConfig {
    public function __construct(
        public readonly SQLExecutorInterface $executor,
        public readonly string $scopeField,
        public readonly string $sharedSecret,
        public readonly string $signingSecret,
        /** @var callable(?array, array): array */
        public readonly mixed $auth,
        public readonly string $dialect = 'postgres',
        public readonly ?string $dbSchema = null,
        public readonly ?array $tableNameMap = null,
        public readonly ?array $excludeTables = null,
        public readonly bool $allowProduction = false,
        public /*readonly*/ ?array $sdk = null,
    ) {}
}
