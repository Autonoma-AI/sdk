# Autonoma Java SDK

Java implementation of the Autonoma Environment Factory SDK. Uses Maven multi-module layout with Java 17+ and Spring Boot 3.x for the server adapter.

## Modules

| Module | Artifact | Description |
|--------|----------|-------------|
| `autonoma-sdk` | `ai.autonoma:autonoma-sdk` | Core protocol (HMAC, refs, graph, handler) |
| `autonoma-spring` | `ai.autonoma:autonoma-spring` | Spring Boot server adapter with JDBC executor |
| `conformance-bridge` | `ai.autonoma:autonoma-conformance-bridge` | Conformance test bridge (internal) |

## Quick Start

### Install

Add to your `pom.xml`:

```xml
<dependency>
    <groupId>ai.autonoma</groupId>
    <artifactId>autonoma-sdk</artifactId>
    <version>0.1.0</version>
</dependency>
<dependency>
    <groupId>ai.autonoma</groupId>
    <artifactId>autonoma-spring</artifactId>
    <version>0.1.0</version>
</dependency>
```

### Spring Boot

```java
@Configuration
public class AutonomaConfig {
    @Bean
    public AutonomaController autonomaController(DataSource dataSource) {
        SQLExecutor executor = new JdbcSQLExecutor(dataSource);
        HandlerConfig config = new HandlerConfig(
            executor,
            "organizationId",
            System.getenv("AUTONOMA_SHARED_SECRET"),
            System.getenv("AUTONOMA_SIGNING_SECRET"),
            user -> AuthResult.ofHeaders(
                Map.of("Authorization", "Bearer " + createToken(user))
            )
        );
        config.setDialect("postgres");
        return new AutonomaController(config);
    }
}
```

The controller registers a POST endpoint at `/api/autonoma` (configurable via `autonoma.endpoint` property).

## Commands

```bash
mvn compile                    # compile all modules
mvn test                       # run all tests
mvn test -pl autonoma-sdk      # test only core SDK
mvn package -DskipTests        # build JARs
```

## Documentation

For protocol-level documentation, see the root [`protocol/`](../../protocol/) directory.
