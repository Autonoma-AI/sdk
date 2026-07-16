<?php

// =============================================================================
// Autonoma SDK — Laravel Example (Factory-driven)
// =============================================================================
// The SDK is factory-driven: every model the dashboard can create has a
// registered factory whose inputFields drives both validation and the discover
// schema. There is no SQL introspection, no Eloquent executor, and no SQL
// fallback — your factories call whatever services your app already has.

use App\Repositories\OrganizationRepository;
use App\Repositories\UserRepository;
use Autonoma\Sdk\Factory;
use Autonoma\Sdk\Types\FieldInfo;
use Autonoma\Sdk\Types\FactoryContext;

return [
    // The column that scopes all models to a tenant — used to isolate test data
    'scope_field' => env('AUTONOMA_SCOPE_FIELD', 'organization_id'),
    // Shared with Autonoma — verifies incoming requests via HMAC-SHA256
    'shared_secret' => env('AUTONOMA_SHARED_SECRET', 'my-shared-secret'),
    // Private to your server — signs the refs token so teardown only deletes what was created
    'signing_secret' => env('AUTONOMA_SIGNING_SECRET', 'my-signing-secret'),
    'path' => 'api/autonoma',
    'middleware' => [],

    // Called after `up` — returns credentials so Autonoma can make authenticated requests
    'auth' => function (?array $user, array $context): array {
        return ['headers' => ['Authorization' => 'Bearer test-token']];
    },

    // Every model the dashboard can create needs a factory.
    // The factory's inputFields drives both validation and discover.
    'factories' => [
        'Organization' => Factory::define(
            inputFields: [
                new FieldInfo('name', 'string', true),
            ],
            create: function (array $data, FactoryContext $ctx) {
                $repo = new OrganizationRepository();
                return $repo->create(['name' => $data['name']]);
            },
            teardown: function (array $record, FactoryContext $ctx) {
                $repo = new OrganizationRepository();
                $repo->delete($record['id']);
            }
        ),

        // $data is validated against inputFields before reaching this function
        'User' => Factory::define(
            inputFields: [
                new FieldInfo('email', 'string', true),
                new FieldInfo('name', 'string', true),
                new FieldInfo('organization_id', 'string', true),
            ],
            create: function (array $data, FactoryContext $ctx) {
                $repo = new UserRepository();
                return $repo->create([
                    'email' => $data['email'],
                    'name' => $data['name'],
                    'organization_id' => $data['organization_id'],
                ]);
            }
        ),
    ],
];
