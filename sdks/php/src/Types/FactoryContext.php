<?php

namespace Autonoma\Sdk\Types;

class FactoryContext
{
    public function __construct(
        /** @var array<string, array<int, array<string, mixed>>> All refs created so far */
        public readonly array $refs,
        /** The SQL executor (for factories that need direct DB access) */
        public readonly SQLExecutorInterface $executor,
        /** The detected or fallback scope value */
        public readonly string $scenarioName,
        /** Unique ID for this test run */
        public readonly string $testRunId,
    ) {}
}
