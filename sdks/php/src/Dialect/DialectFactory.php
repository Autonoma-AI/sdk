<?php
namespace Autonoma\Sdk\Dialect;

class DialectFactory
{
    public static function get(string $name = 'postgres'): DialectInterface
    {
        return match ($name) {
            'postgres' => new PostgresDialect(),
            'mysql' => new MySQLDialect(),
            default => throw new \InvalidArgumentException("Dialect \"{$name}\" is not yet supported. Currently only \"postgres\" and \"mysql\" are available."),
        };
    }
}
