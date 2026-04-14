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

    // -------------------------------------------------------------------------
    // Factories (Hybrid Mode)
    // -------------------------------------------------------------------------
    // Register factories for models that have business logic (password hashing,
    // slug generation, external service calls, etc.). Models WITHOUT a factory
    // (Project, Task) fall back to raw SQL INSERT — which works fine for simple
    // tables without business logic.
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
