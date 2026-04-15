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
            // Connects the SDK to your database through your ORM (Prisma, Drizzle, SQLAlchemy, etc.)
            executor,
            // The column that scopes all models to a tenant (e.g. organization_id). The SDK uses this to
            // isolate test data and ensure teardown only removes records belonging to the test run.
            "organization_id",
            // Shared between your server and Autonoma. Used to verify incoming requests via HMAC-SHA256.
            System.getenv("AUTONOMA_SHARED_SECRET") != null ? System.getenv("AUTONOMA_SHARED_SECRET") : "my-shared-secret",
            // Private to your server only. Used to sign the refs token that tracks created records,
            // so teardown can only delete what was created.
            System.getenv("AUTONOMA_SIGNING_SECRET") != null ? System.getenv("AUTONOMA_SIGNING_SECRET") : "my-signing-secret",
            // Called after entity creation during `up`. Returns credentials (cookies, headers, tokens)
            // so Autonoma can make authenticated requests as the test user.
            (user, context) -> AuthResult.ofHeaders(
                Map.of("Authorization", "Bearer test-token")
            )
        );
        config.setDialect("postgres");

        // Custom create/teardown logic for models with business logic (password hashing, slug
        // generation, etc.). Models without a factory fall back to raw SQL INSERT.
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
