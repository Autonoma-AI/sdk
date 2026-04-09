<?php
namespace Autonoma\Sdk\Dialect;

class MySQLDialect implements DialectInterface
{
    public function getName(): string { return 'mysql'; }
    public function supportsReturning(): bool { return false; }
    public function param(int $_index): string { return '?'; }
    public function quoteId(string $name): string { return '`' . $name . '`'; }
    public function tablesSql(string $schema): string { return SqlQueries::replaceSchema(SqlQueries::MYSQL_TABLES, $schema); }
    public function columnsSql(string $schema): string { return SqlQueries::replaceSchema(SqlQueries::MYSQL_COLUMNS, $schema); }
    public function primaryKeysSql(string $schema): string { return SqlQueries::replaceSchema(SqlQueries::MYSQL_PRIMARY_KEYS, $schema); }
    public function foreignKeysSql(string $schema): string { return SqlQueries::replaceSchema(SqlQueries::MYSQL_FOREIGN_KEYS, $schema); }
    public function enumsSql(string $schema): string { return SqlQueries::MYSQL_ENUMS; }
}
