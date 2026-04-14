<?php

namespace App\Repositories;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class OrganizationRepository
{
    /**
     * Create an organization with business logic:
     * - Generates a URL-friendly slug from the name
     * - Sets up default organization settings
     * - Could trigger external service provisioning (e.g., billing account)
     *
     * @param array{name: string} $data
     * @return array{id: string, name: string, slug: string}
     */
    public function create(array $data): array
    {
        $id = (string) Str::uuid();
        $name = $data['name'];

        // Business logic: generate a slug from the organization name
        $slug = Str::slug($name);

        DB::table('organizations')->insert([
            'id' => $id,
            'name' => $name,
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        // In a real app, you might also:
        // - Create default roles/permissions
        // - Provision a billing account
        // - Send a welcome email to the creator

        return [
            'id' => $id,
            'name' => $name,
            'slug' => $slug,
        ];
    }

    /**
     * Delete an organization and clean up related resources.
     *
     * In a real app, this might also:
     * - Cancel billing subscriptions
     * - Archive data instead of hard-deleting
     * - Notify team members
     */
    public function delete(string $id): void
    {
        DB::table('organizations')->where('id', $id)->delete();
    }
}
