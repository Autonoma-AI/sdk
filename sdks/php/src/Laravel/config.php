<?php

return [
    /*
    |--------------------------------------------------------------------------
    | Autonoma SDK Configuration
    |--------------------------------------------------------------------------
    */

    // Scope field name (camelCase, e.g. 'organizationId')
    'scope_field' => env('AUTONOMA_SCOPE_FIELD', 'organizationId'),

    // Shared secret (known by both Autonoma and your SDK)
    'shared_secret' => env('AUTONOMA_SHARED_SECRET', ''),

    // Signing secret (only known by your SDK -- never share with Autonoma)
    'signing_secret' => env('AUTONOMA_SIGNING_SECRET', ''),

    // Allow SDK to run in production (dangerous!)
    'allow_production' => (bool) env('AUTONOMA_ALLOW_PRODUCTION', false),

    // Route path for the Autonoma endpoint
    'path' => env('AUTONOMA_PATH', 'api/autonoma'),

    // Middleware to apply to the Autonoma route
    'middleware' => [],

    // Factories: register one per model. Each factory defines how to create
    // and teardown entities. See Factory::define() for details.
    // 'factories' => [
    //     'Organization' => Factory::define(
    //         create: fn(array $data, FactoryContext $ctx) => Organization::create($data)->toArray(),
    //         inputFields: [
    //             Factory::field('name', 'string'),
    //         ],
    //         teardown: fn(array $record, FactoryContext $ctx) => Organization::destroy($record['id']),
    //     ),
    // ],
    'factories' => [],

    // Auth callback (required) -- receives first User record (or null) and auth context, returns auth credentials.
    // Supports three strategies: cookies, headers, or credentials.
    // 'auth' => function (?array $user, array $ctx) {
    //     return ['cookies' => [['name' => 'session', 'value' => '...']]];        // session cookies
    //     return ['headers' => ['Authorization' => 'Bearer ...']];                 // bearer token
    //     return ['credentials' => ['username' => '...', 'password' => '...']];    // username/password
    // },
    'auth' => null,
];
