// =============================================================================
// Autonoma SDK — Spring Boot + JDBC Example (Hybrid Factories + SQL)
// =============================================================================
// This example shows how to use factories for models with business logic
// (Organization, User) while letting the SDK handle simpler models (Project,
// Task) via raw SQL. This "hybrid" approach gives you the best of both worlds:
// correct business logic where it matters, zero setup where it doesn't.

package com.example.autonoma;

import ai.autonoma.spring.AutonomaController;
import ai.autonoma.spring.JdbcSQLExecutor;
import ai.autonoma.sdk.FactoryUtil;
import ai.autonoma.sdk.types.AuthResult;
import ai.autonoma.sdk.types.FactoryDefinition;
import ai.autonoma.sdk.types.HandlerConfig;
import ai.autonoma.sdk.types.SQLExecutor;
import com.example.autonoma.repositories.OrganizationRepository;
import com.example.autonoma.repositories.UserRepository;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import javax.sql.DataSource;
import java.util.Map;

@Configuration
public class AutonomaConfig {
    @Bean
    public AutonomaController autonomaController(DataSource dataSource) {
        SQLExecutor executor = new JdbcSQLExecutor(dataSource);

        // -----------------------------------------------------------------------
        // Initialize repositories
        // -----------------------------------------------------------------------
        OrganizationRepository organizationRepo = new OrganizationRepository(dataSource);
        UserRepository userRepo = new UserRepository(dataSource);

        HandlerConfig config = new HandlerConfig(
            executor,
            "organization_id",
            System.getenv("AUTONOMA_SHARED_SECRET") != null ? System.getenv("AUTONOMA_SHARED_SECRET") : "my-shared-secret",
            System.getenv("AUTONOMA_SIGNING_SECRET") != null ? System.getenv("AUTONOMA_SIGNING_SECRET") : "my-signing-secret",
            (user, context) -> AuthResult.ofHeaders(
                Map.of("Authorization", "Bearer test-token")
            )
        );
        config.setDialect("postgres");

        // -----------------------------------------------------------------------
        // Register factories for models that have business logic
        // -----------------------------------------------------------------------
        // Factories let you use your own repositories/services to create test data.
        // The SDK still handles scenario resolution, FK ordering, and teardown —
        // but delegates actual creation to your code for models that need it.
        //
        // Models WITHOUT a factory (Project, Task) fall back to raw SQL INSERT,
        // which works fine for simple tables without business logic.
        config.setFactories(Map.of(
            // Organization: uses the repository which handles slug generation,
            // default settings, external service setup, etc.
            "Organization", FactoryUtil.defineFactory(
                (data, ctx) -> organizationRepo.create(data),
                (record, ctx) -> organizationRepo.delete((String) record.get("id"))
            ),

            // User: uses the repository which handles password hashing,
            // email normalization, and other business logic.
            // No teardown defined — the SDK falls back to SQL DELETE.
            "User", FactoryUtil.defineFactory(
                (data, ctx) -> userRepo.create(data)
            )

            // Project and Task have no factories — they use raw SQL INSERT.
            // This is fine because they're simple tables with no business logic.
        ));

        return new AutonomaController(config);
    }
}
