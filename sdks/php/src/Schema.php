<?php

namespace Autonoma\Sdk;

use Autonoma\Sdk\Types\FieldInfo;
use Autonoma\Sdk\Types\ModelInfo;
use Autonoma\Sdk\Types\SchemaInfo;

/**
 * Build the SDK's wire-shape schema from registered factories.
 *
 * The dashboard's discover response carries a schema block that lists every
 * model the host can create along with each model's fields. With factories,
 * this comes from each factory's inputFields array.
 */
class Schema
{
    /**
     * Valid SDK type strings for input fields.
     */
    private const VALID_TYPES = [
        'string', 'integer', 'number', 'boolean',
        'timestamp', 'date', 'uuid', 'json',
    ];

    /**
     * Convert OrgMember to org_member for cosmetic tableName.
     */
    private static function camelToSnake(string $name): string
    {
        $out = '';
        for ($i = 0; $i < strlen($name); $i++) {
            $ch = $name[$i];
            if (ctype_upper($ch) && $i > 0 && !ctype_upper($name[$i - 1])) {
                $out .= '_';
            }
            $out .= strtolower($ch);
        }
        return $out;
    }

    /**
     * Build FieldInfo list from a factory's inputFields, prepending a synthetic id field.
     *
     * @param FieldInfo[] $inputFields
     * @return FieldInfo[]
     */
    private static function buildModelFields(array $inputFields): array
    {
        $fields = [
            new FieldInfo(
                name: 'id',
                type: 'string',
                isRequired: false,
                isId: true,
                hasDefault: true,
            ),
        ];

        foreach ($inputFields as $field) {
            $fields[] = $field;
        }

        return $fields;
    }

    /**
     * Build the SDK's discover-time schema from registered factories.
     *
     * @param array<string, \Autonoma\Sdk\Types\FactoryDefinition> $factories
     */
    public static function buildSchemaFromFactories(array $factories, string $scopeField): SchemaInfo
    {
        $models = [];

        foreach ($factories as $entity => $factory) {
            if (empty($factory->inputFields)) {
                throw new \RuntimeException(
                    "Factory \"{$entity}\" has no inputFields. " .
                    "Every factory must declare inputFields in defineFactory(...)."
                );
            }

            $models[] = new ModelInfo(
                name: $entity,
                tableName: self::camelToSnake($entity),
                fields: self::buildModelFields($factory->inputFields),
            );
        }

        return new SchemaInfo(
            models: $models,
            edges: [],
            relations: [],
            scopeField: $scopeField,
        );
    }

    /**
     * Serialise a SchemaInfo to the JSON shape the dashboard expects.
     *
     * @return array<string, mixed>
     */
    public static function schemaToWire(SchemaInfo $schema): array
    {
        return [
            'models' => array_map(fn(ModelInfo $m) => [
                'name' => $m->name,
                'tableName' => $m->tableName,
                'fields' => array_map(fn(FieldInfo $f) => [
                    'name' => $f->name,
                    'type' => $f->type,
                    'isRequired' => $f->isRequired,
                    'isId' => $f->isId,
                    'hasDefault' => $f->hasDefault,
                ], $m->fields),
            ], $schema->models),
            'edges' => [],
            'relations' => [],
            'scopeField' => $schema->scopeField,
        ];
    }
}
