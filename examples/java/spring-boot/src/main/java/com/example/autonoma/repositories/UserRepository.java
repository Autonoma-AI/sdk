// =============================================================================
// User Repository
// =============================================================================
// A typical repository with business logic that raw SQL can't replicate.
// Password hashing, email normalization, and welcome email suppression
// are common examples of why factories are needed.

package com.example.autonoma.repositories;

import javax.sql.DataSource;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.util.HexFormat;
import java.util.Map;
import java.util.UUID;

public class UserRepository {

    private final DataSource dataSource;

    public UserRepository(DataSource dataSource) {
        this.dataSource = dataSource;
    }

    /**
     * Create a user with business logic: normalize email, hash a default password.
     * This shows why raw SQL INSERT would break: it doesn't know about
     * password hashing, email normalization, etc.
     */
    public Map<String, Object> create(Map<String, Object> data) throws Exception {
        String id = UUID.randomUUID().toString();
        String name = (String) data.get("name");
        String organizationId = (String) data.get("organization_id");

        // Business logic: normalize email and hash a default password
        String normalizedEmail = ((String) data.get("email")).trim().toLowerCase();
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] hash = digest.digest("default-test-password".getBytes(StandardCharsets.UTF_8));
        String hashedPassword = HexFormat.of().formatHex(hash);

        try (Connection conn = dataSource.getConnection();
             PreparedStatement stmt = conn.prepareStatement(
                 "INSERT INTO \"user\" (id, email, name, organization_id) VALUES (?, ?, ?, ?)")) {
            stmt.setString(1, id);
            stmt.setString(2, normalizedEmail);
            stmt.setString(3, name);
            stmt.setString(4, organizationId);
            // In a real app, the User model would have a password field.
            // This shows why raw SQL INSERT would break: it doesn't know
            // about password hashing, email normalization, etc.
            stmt.executeUpdate();
        }

        return Map.of("id", id, "email", normalizedEmail, "name", name, "organization_id", organizationId);
    }
}
