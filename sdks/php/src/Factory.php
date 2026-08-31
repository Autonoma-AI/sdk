<?php

namespace Autonoma\Sdk;

use Autonoma\Sdk\Types\FactoryDefinition;

/**
 * Optional factory helper library.
 *
 * Factories are NOT wired to the wire protocol in v2 - the platform only calls
 * a scenario's up and down. A scenario's up/down may use factories internally to
 * create and tear down entities through the app's real logic (password hashing,
 * external service calls, state machines), exactly as production data is created.
 */
class Factory
{
    /**
     * Define a factory for creating entities.
     *
     * The create callable receives an associative array and a FactoryContext and
     * must return an array with at least an 'id' key. teardown is optional;
     * without it the caller has no way to remove records the factory created.
     *
     * @param callable $create Called with (array $data, FactoryContext $ctx), returns array with 'id'
     * @param callable|null $teardown Optional, called with (array $record, FactoryContext $ctx)
     * @param array<int, array<string, mixed>> $inputFields Optional field declarations for the host's own validation
     */
    public static function define(
        callable $create,
        ?callable $teardown = null,
        array $inputFields = [],
    ): FactoryDefinition {
        return new FactoryDefinition(
            create: $create,
            teardown: $teardown,
            inputFields: $inputFields,
        );
    }
}
