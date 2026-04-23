// =============================================================================
// Organization Repository
// =============================================================================
// A typical repository that wraps JDBC with business logic.
// In a real app, this might generate slugs, set up billing, create default
// settings, or call external services (e.g., Stripe customer creation).

package com.example.autonoma.repositories;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.Map;
import java.util.UUID;

public class OrganizationRepository {

    private final DataSource dataSource;

    public OrganizationRepository(DataSource dataSource) {
        this.dataSource = dataSource;
    }

    /**
     * Create an organization with business logic.
     * In a real app you might also:
     * - Create a Stripe customer
     * - Set up default organization settings
     * - Send a welcome email to the creator
     */
    public Map<String, Object> create(Map<String, Object> data) throws Exception {
        String id = UUID.randomUUID().toString();
        String name = (String) data.get("name");

        try (Connection conn = dataSource.getConnection();
             PreparedStatement stmt = conn.prepareStatement(
                 "INSERT INTO organization (id, name) VALUES (?, ?)")) {
            stmt.setString(1, id);
            stmt.setString(2, name);
            stmt.executeUpdate();
        }

        return Map.of("id", id, "name", name);
    }

    /**
     * Delete an organization with cleanup logic.
     * In a real app: cancel Stripe subscription, revoke API keys, etc.
     */
    public void delete(String id) throws Exception {
        try (Connection conn = dataSource.getConnection();
             PreparedStatement stmt = conn.prepareStatement(
                 "DELETE FROM organization WHERE id = ?")) {
            stmt.setString(1, id);
            stmt.executeUpdate();
        }
    }
}
