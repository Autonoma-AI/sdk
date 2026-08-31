<?php

namespace Autonoma\Sdk\Types;

/**
 * A named scenario. up provisions an isolated environment a test needs; the
 * optional down tears it back down. Register scenarios on
 * HandlerConfig::$scenarios. Build one with Scenario::defineScenario().
 */
final class ScenarioDefinition
{
    public function __construct(
        /** Stable identifier the platform calls up/down by. */
        public readonly string $name,
        /** Human-readable summary shown in discover. */
        public readonly string $description,
        /**
         * @var callable(ScenarioUpContext): (ScenarioUpResult|array<string, mixed>)
         * Free-form provisioning code returning the environment.
         */
        public readonly mixed $up,
        /**
         * @var callable(ScenarioDownContext): void|null
         * Optional teardown; a null down is a no-op.
         */
        public readonly mixed $down = null,
    ) {}
}
