<?php
namespace Autonoma\Sdk\Dialect;

interface DialectInterface
{
    public function getName(): string;
    public function supportsReturning(): bool;
    public function param(int $index): string;
    public function quoteId(string $name): string;
    public function tablesSql(string $schema): string;
    public function columnsSql(string $schema): string;
    public function primaryKeysSql(string $schema): string;
    public function foreignKeysSql(string $schema): string;
    public function enumsSql(string $schema): string;
}
