<?php

// =============================================================================
// Autonoma SDK — Laravel Example (Hybrid Factories + SQL)
// =============================================================================
// This example shows how to use factories for models with business logic
// (Organization, User) while letting the SDK handle simpler models (Project,
// Task) via raw SQL. This "hybrid" approach gives you the best of both worlds:
// correct business logic where it matters, zero setup where it doesn't.

use App\Repositories\OrganizationRepository;
use App\Repositories\UserRepository;
use Autonoma\Sdk\Factory;
use Autonoma\Sdk\Types\FactoryContext;

return [
    'connection' => env('AUTONOMA_DB_CONNECTION'),
    // The column that scopes all models to a tenant (e.g. organization_id). The SDK uses this to
    // isolate test data and ensure teardown only removes records belonging to the test run.
    'scope_field' => env('AUTONOMA_SCOPE_FIELD', 'organization_id'),
    // Shared between your server and Autonoma. Used to verify incoming requests via HMAC-SHA256.
    'shared_secret' => env('AUTONOMA_SHARED_SECRET', 'my-shared-secret'),
    // Private to your server only. Used to sign the refs token that tracks created records,
    // so teardown can only delete what was created.
    'signing_secret' => env('AUTONOMA_SIGNING_SECRET', 'my-signing-secret'),
    'dialect' => env('AUTONOMA_DIALECT', 'postgres'),
    'db_schema' => env('AUTONOMA_DB_SCHEMA'),
    'exclude_tables' => ['migrations'],
    'allow_production' => false,
    'path' => 'api/autonoma',
    'middleware' => [],
    // Called after entity creation during `up`. Returns credentials (cookies, headers, tokens)
    // so Autonoma can make authenticated requests as the test user.
    'auth' => function (?array $user, array $context): array {
        return ['headers' => ['Authorization' => 'Bearer test-token']];
    },

    // Custom create/teardown logic for models with business logic (password hashing, slug
    // generation, etc.). Models without a factory fall back to raw SQL INSERT.
    'factories' => [
        // Organization: uses the repository which handles slug generation,
        // default settings, external service setup, etc.
        'Organization' => Factory::define(
            function (array $data, FactoryContext $ctx) {
                $repo = new OrganizationRepository();
                return $repo->create([
                    'name' => $data['name'],
                ]);
            },
            // Custom teardown: cleans up related resources (billing, etc.)
            function (array $record, FactoryContext $ctx) {
                $repo = new OrganizationRepository();
                $repo->delete($record['id']);
            }
        ),

        // User: uses the repository which handles password hashing,
        // email normalization, and other business logic.
        // No teardown defined — the SDK falls back to SQL DELETE.
        'User' => Factory::define(
            function (array $data, FactoryContext $ctx) {
                $repo = new UserRepository();
                return $repo->create([
                    'email' => $data['email'],
                    'name' => $data['name'],
                    'organization_id' => $data['organization_id'],
                ]);
            }
        ),

        // Project and Task have no factories — they use raw SQL INSERT.
        // This is fine because they're simple tables with no business logic.
    ],
];
