<?php

namespace Autonoma\Sdk\Types;

/**
 * Context passed to a scenario's up.
 *
 * Seed the uniqueness helpers (Unique::uniqueEmail, Unique::uniqueSlug, ...)
 * from testRunId so values are unique per run yet reproducible between up and
 * a later down.
 */
final class ScenarioUpContext
{
    public function __construct(
        public readonly string $testRunId,
    ) {}
}
