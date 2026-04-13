<?php

return [
    'connection' => env('AUTONOMA_DB_CONNECTION'),
    'scope_field' => env('AUTONOMA_SCOPE_FIELD', 'organization_id'),
    'shared_secret' => env('AUTONOMA_SHARED_SECRET', 'my-shared-secret'),
    'signing_secret' => env('AUTONOMA_SIGNING_SECRET', 'my-signing-secret'),
    'dialect' => env('AUTONOMA_DIALECT', 'postgres'),
    'db_schema' => env('AUTONOMA_DB_SCHEMA'),
    'exclude_tables' => ['migrations'],
    'allow_production' => false,
    'path' => 'api/autonoma',
    'middleware' => [],
    'auth' => function (?array $user, array $context): array {
        return ['headers' => ['Authorization' => 'Bearer test-token']];
    },
];
