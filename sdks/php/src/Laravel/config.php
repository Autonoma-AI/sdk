<?php

return [
    /*
    |--------------------------------------------------------------------------
    | Autonoma SDK Configuration
    |--------------------------------------------------------------------------
    */

    // Database connection name (null = default)
    'connection' => env('AUTONOMA_DB_CONNECTION'),

    // Scope field name (camelCase, e.g. 'organizationId')
    'scope_field' => env('AUTONOMA_SCOPE_FIELD', 'organizationId'),

    // Shared secret (known by both Autonoma and your SDK)
    'shared_secret' => env('AUTONOMA_SHARED_SECRET', ''),

    // Signing secret (only known by your SDK — never share with Autonoma)
    'signing_secret' => env('AUTONOMA_SIGNING_SECRET', ''),

    // Database dialect: 'postgres' or 'mysql'
    'dialect' => env('AUTONOMA_DIALECT', 'postgres'),

    // Database schema name (required for MySQL, defaults to 'public' for Postgres)
    'db_schema' => env('AUTONOMA_DB_SCHEMA'),

    // Custom model → table name mapping (optional)
    // 'table_name_map' => ['User' => 'users', 'Organization' => 'organizations'],
    'table_name_map' => null,

    // Tables to exclude from introspection
    'exclude_tables' => ['_prisma_migrations', 'migrations'],

    // Allow SDK to run in production (dangerous!)
    'allow_production' => (bool) env('AUTONOMA_ALLOW_PRODUCTION', false),

    // Route path for the Autonoma endpoint
    'path' => env('AUTONOMA_PATH', 'api/autonoma'),

    // Middleware to apply to the Autonoma route
    'middleware' => [],

    // Auth callback (required) — receives first User record (or null), returns auth credentials.
    // Supports three strategies: cookies, headers, or credentials.
    // 'auth' => function (?array $user) {
    //     return ['cookies' => [['name' => 'session', 'value' => '...']]];        // session cookies
    //     return ['headers' => ['Authorization' => 'Bearer ...']];                 // bearer token
    //     return ['credentials' => ['username' => '...', 'password' => '...']];    // username/password
    // },
    'auth' => null,
];
