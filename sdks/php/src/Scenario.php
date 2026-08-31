<?php

namespace Autonoma\Sdk;

use Autonoma\Sdk\Types\ScenarioDefinition;

/**
 * Define a named scenario.
 *
 * A scenario's up is free-form code (loops, conditionals, real API calls) that
 * provisions an isolated environment and returns the auth/teardown a test run
 * needs. An omitted down is a no-op. Register scenarios with
 * new HandlerConfig(..., scenarios: [Scenario::defineScenario(...)]).
 *
 * up and down are callables. up receives a ScenarioUpContext and returns either
 * a ScenarioUpResult or a plain associative array with 'auth' / 'teardown'
 * keys. down receives a ScenarioDownContext.
 *
 * @example
 *   Scenario::defineScenario(
 *       name: 'single-user',
 *       description: 'One verified user in a fresh org',
 *       up: function (ScenarioUpContext $ctx): ScenarioUpResult {
 *           $email = Unique::uniqueEmail($ctx->testRunId);
 *           $user = User::create(['email' => $email]);
 *           return new ScenarioUpResult(
 *               auth: ['headers' => ['Authorization' => "Bearer {$user->token}"]],
 *               teardown: ['userId' => $user->id],
 *           );
 *       },
 *       down: fn(ScenarioDownContext $ctx) => User::destroy($ctx->teardown['userId']),
 *   );
 */
class Scenario
{
    public static function defineScenario(
        string $name,
        string $description,
        callable $up,
        ?callable $down = null,
    ): ScenarioDefinition {
        if ($name === '') {
            throw new \InvalidArgumentException('Scenario "name" must be a non-empty string');
        }

        return new ScenarioDefinition(
            name: $name,
            description: $description,
            up: $up,
            down: $down,
        );
    }
}
