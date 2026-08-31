<?php

namespace Autonoma\Sdk\Types;

/**
 * Context passed to a scenario's down. Every field is recovered from the
 * verified teardown token, so a down never trusts anything on the request body.
 */
final class ScenarioDownContext
{
    public function __construct(
        /** The scenario name, recovered from the verified teardown token. */
        public readonly string $name,
        /** @var array<string, mixed> The handles this scenario returned from up. */
        public readonly array $teardown,
        /** The testRunId captured at up time. */
        public readonly string $testRunId,
    ) {}
}
