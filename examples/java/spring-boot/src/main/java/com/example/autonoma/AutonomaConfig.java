// =============================================================================
// Autonoma SDK — Spring Boot Example (Factory-driven)
// =============================================================================
// The SDK is factory-driven: every model the dashboard can create has a
// registered factory whose inputClass (a Java record) drives both validation
// and the discover schema. There is no SQL introspection, no JDBC executor,
// and no SQL fallback — your factories call whatever services your app has.

package com.example.autonoma;

import ai.autonoma.spring.AutonomaController;
import ai.autonoma.sdk.FactoryUtil;
import ai.autonoma.sdk.types.AuthResult;
import ai.autonoma.sdk.types.HandlerConfig;
import com.example.autonoma.repositories.OrganizationRepository;
import com.example.autonoma.repositories.UserRepository;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import javax.sql.DataSource;
import java.util.Map;

@Configuration
public class AutonomaConfig {

    // Input records — drive both validation and discover schema
    public record OrganizationInput(String name) {}
    public record UserInput(String email, String name, String organizationId) {}

    @Bean
    public AutonomaController autonomaController(DataSource dataSource) {
        OrganizationRepository organizationRepo = new OrganizationRepository(dataSource);
        UserRepository userRepo = new UserRepository(dataSource);

        HandlerConfig config = new HandlerConfig(
            // The column that scopes all models to a tenant — used to isolate test data
            "organization_id",
            // Shared with Autonoma — verifies incoming requests via HMAC-SHA256
            System.getenv("AUTONOMA_SHARED_SECRET") != null ? System.getenv("AUTONOMA_SHARED_SECRET") : "my-shared-secret",
            // Private to your server — signs the refs token so teardown only deletes what was created
            System.getenv("AUTONOMA_SIGNING_SECRET") != null ? System.getenv("AUTONOMA_SIGNING_SECRET") : "my-signing-secret",
            // Called after `up` — returns credentials so Autonoma can make authenticated requests
            (user, context) -> AuthResult.ofHeaders(
                Map.of("Authorization", "Bearer test-token")
            )
        );

        // Required: the endpoint returns 404 unless this is true. The SDK never
        // inspects JAVA_ENV/SPRING_PROFILES_ACTIVE — tie it to your own condition
        // to keep it off in prod, e.g. !"production".equals(System.getenv("JAVA_ENV")).
        config.setAllowProduction(true);

        // Every model the dashboard can create needs a factory.
        // The factory's inputClass drives both validation and discover.
        config.setFactories(Map.of(
            "Organization", FactoryUtil.defineFactory(
                OrganizationInput.class,
                (data, ctx) -> organizationRepo.create(data),
                (record, ctx) -> organizationRepo.delete((String) record.get("id"))
            ),
            // data is automatically deserialized into UserInput
            "User", FactoryUtil.defineFactory(
                UserInput.class,
                (data, ctx) -> userRepo.create(data)
            )
        ));

        return new AutonomaController(config);
    }
}
