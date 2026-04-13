package com.example.autonoma;

import ai.autonoma.spring.AutonomaController;
import ai.autonoma.spring.JdbcSQLExecutor;
import ai.autonoma.sdk.types.AuthResult;
import ai.autonoma.sdk.types.HandlerConfig;
import ai.autonoma.sdk.types.SQLExecutor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import javax.sql.DataSource;
import java.util.Map;

@Configuration
public class AutonomaConfig {
    @Bean
    public AutonomaController autonomaController(DataSource dataSource) {
        SQLExecutor executor = new JdbcSQLExecutor(dataSource);
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
        return new AutonomaController(config);
    }
}
