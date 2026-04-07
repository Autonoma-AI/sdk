<?php
namespace Autonoma\Sdk\Dialect;

class PostgresDialect implements DialectInterface
{
    public function getName(): string { return 'postgres'; }
    public function supportsReturning(): bool { return true; }
    public function param(int $index): string { return "\${$index}"; }
    public function quoteId(string $name): string { return '"' . $name . '"'; }
    public function tablesSql(string $schema): string { return SqlQueries::replaceSchema(SqlQueries::POSTGRES_TABLES, $schema); }
    public function columnsSql(string $schema): string { return SqlQueries::replaceSchema(SqlQueries::POSTGRES_COLUMNS, $schema); }
    public function primaryKeysSql(string $schema): string { return SqlQueries::replaceSchema(SqlQueries::POSTGRES_PRIMARY_KEYS, $schema); }
    public function foreignKeysSql(string $schema): string { return SqlQueries::replaceSchema(SqlQueries::POSTGRES_FOREIGN_KEYS, $schema); }
    public function enumsSql(string $schema): string { return SqlQueries::POSTGRES_ENUMS; }
}
