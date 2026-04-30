<?php

namespace Autonoma\Sdk;

use Autonoma\Sdk\Types\FactoryDefinition;
use Autonoma\Sdk\Types\FieldInfo;

/**
 * Factory definition helper.
 *
 * The SDK is factory-driven: every model the dashboard can create is owned
 * by a registered factory. inputFields is required -- it is what the SDK uses
 * to validate inputs before calling create and to populate the discover schema,
 * replacing the SQL introspection that earlier versions relied on.
 */
class Factory
{
    /**
     * Define a factory for creating entities.
     *
     * The factory's `create` function receives a validated associative array
     * (fields validated against inputFields) and a FactoryContext, and must
     * return an array with at least an 'id' key.
     *
     * inputFields is required because the SDK derives the discover schema
     * from it (no DB introspection).
     *
     * teardown is optional but strongly recommended; without it the SDK has
     * no way to remove records the factory created.
     *
     * @param callable $create Called with (array $data, FactoryContext $ctx), must return array with 'id'
     * @param FieldInfo[] $inputFields Field definitions for validation and discover schema
     * @param callable|null $teardown Optional, called with (array $record, FactoryContext $ctx)
     */
    public static function define(
        callable $create,
        array $inputFields,
        ?callable $teardown = null,
    ): FactoryDefinition {
        if (empty($inputFields)) {
            throw new \InvalidArgumentException(
                'Factory must declare inputFields. The SDK derives the discover schema from it; ' .
                'there is no automatic fallback.'
            );
        }

        foreach ($inputFields as $field) {
            if (!$field instanceof FieldInfo) {
                throw new \InvalidArgumentException(
                    'Each element of inputFields must be a FieldInfo instance.'
                );
            }
        }

        return new FactoryDefinition(
            create: $create,
            inputFields: $inputFields,
            teardown: $teardown,
        );
    }

    /**
     * Convenience helper to create a FieldInfo for use in inputFields arrays.
     */
    public static function field(
        string $name,
        string $type = 'string',
        bool $isRequired = true,
        bool $hasDefault = false,
    ): FieldInfo {
        return new FieldInfo(
            name: $name,
            type: $type,
            isRequired: $isRequired,
            isId: false,
            hasDefault: $hasDefault,
        );
    }
}
