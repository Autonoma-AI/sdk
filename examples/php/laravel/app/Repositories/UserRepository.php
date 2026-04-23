<?php

namespace App\Repositories;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class UserRepository
{
    /**
     * Create a user with business logic:
     * - Hashes the password using SHA-256
     * - Normalizes the email to lowercase and trims whitespace
     *
     * @param array{email: string, name: string, organization_id: string} $data
     * @return array{id: string, email: string, name: string, organization_id: string}
     */
    public function create(array $data): array
    {
        $id = (string) Str::uuid();

        // Business logic: normalize email (lowercase, trim whitespace)
        $email = strtolower(trim($data['email']));

        // Business logic: hash the password
        // In a real app you'd use bcrypt via Hash::make(), but we use sha256
        // here to demonstrate the pattern without framework dependencies.
        $hashedPassword = hash('sha256', $data['password'] ?? 'default-password');

        $name = $data['name'];
        $organizationId = $data['organization_id'];

        DB::table('users')->insert([
            'id' => $id,
            'email' => $email,
            'name' => $name,
            'organization_id' => $organizationId,
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        // In a real app, you might also:
        // - Send a verification email
        // - Create a default user profile
        // - Log the signup event for analytics

        return [
            'id' => $id,
            'email' => $email,
            'name' => $name,
            'organization_id' => $organizationId,
        ];
    }
}
