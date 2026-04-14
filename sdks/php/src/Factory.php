<?php

namespace Autonoma\Sdk;

use Autonoma\Sdk\Types\FactoryDefinition;

class Factory
{
    /**
     * Define a factory for creating entities via user code instead of raw SQL.
     * The factory's `create` function receives pre-resolved fields (temp IDs replaced with real IDs)
     * and must return at least the primary key field.
     *
     * @param callable $create  Called with (array $data, FactoryContext $ctx), must return array with at least PK
     * @param callable|null $teardown  Optional, called with (array $record, FactoryContext $ctx)
     */
    public static function define(callable $create, ?callable $teardown = null): FactoryDefinition
    {
        return new FactoryDefinition(create: $create, teardown: $teardown);
    }
}
