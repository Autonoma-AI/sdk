<?php
namespace Autonoma\Sdk\Types;
interface SQLExecutorInterface {
    /** @return array<int, array<string, mixed>> */
    public function query(string $sql, ?array $params = null): array;
    public function transaction(callable $fn): mixed;
}
