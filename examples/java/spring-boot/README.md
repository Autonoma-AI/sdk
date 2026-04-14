# Autonoma SDK — Spring Boot + JDBC Example

A minimal Spring Boot application using the Autonoma SDK with JDBC and PostgreSQL.

## What this example does

This example shows how to wire up the Autonoma Environment Factory endpoint in a Spring Boot app using JDBC. The endpoint allows Autonoma to discover your schema, create test data, and tear it down.

## Prerequisites

- Java 17+
- Maven 3.8+
- Docker (for PostgreSQL)

## Quick start

### 1. Start PostgreSQL

```bash
docker run --rm -d \
  --name autonoma-postgres \
  -e POSTGRES_USER=autonoma \
  -e POSTGRES_PASSWORD=autonoma \
  -e POSTGRES_DB=autonoma_example \
  -p 5432:5432 \
  postgres:16-alpine
```

### 2. Build and run

```bash
mvn spring-boot:run
```

The server will start on http://localhost:3000. Spring Boot automatically runs `schema.sql` on startup to create the database tables.

### 3. Test it

```bash
BODY='{"action":"discover"}'
SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "my-shared-secret" | awk '{print $2}')

curl -X POST http://localhost:3000/api/autonoma \
  -H "Content-Type: application/json" \
  -H "x-signature: $SIGNATURE" \
  -d "$BODY"
```

### 4. Clean up

```bash
docker stop autonoma-postgres
```

## Project structure

```
├── pom.xml                                          # Maven project with Spring Boot + Autonoma SDK
└── src/main/
    ├── java/com/example/autonoma/
    │   ├── Application.java                         # Spring Boot entry point
    │   └── AutonomaConfig.java                      # Autonoma SDK configuration
    └── resources/
        ├── application.properties                   # Database and server config
        └── schema.sql                               # Table definitions (auto-run on startup)
```

## How it works

The key integration in `AutonomaConfig.java`:

```java
@Configuration
public class AutonomaConfig {
    @Bean
    public AutonomaController autonomaController(DataSource dataSource) {
        SQLExecutor executor = new JdbcSQLExecutor(dataSource);
        HandlerConfig config = new HandlerConfig(
            executor,
            "organization_id",
            "my-shared-secret",
            "my-signing-secret",
            (user, context) -> AuthResult.ofHeaders(
                Map.of("Authorization", "Bearer test-token")
            )
        );
        config.setDialect("postgres");
        return new AutonomaController(config);
    }
}
```

The `AutonomaController` bean registers a `POST /api/autonoma` endpoint that handles all three Autonoma actions (discover, up, down). Spring Boot's auto-configured `DataSource` is injected and wrapped in a `JdbcSQLExecutor` for the SDK to use.
