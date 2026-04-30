# Autonoma Java SDK

Java implementation of the Autonoma Environment Factory SDK. Uses Maven multi-module layout with Java 17+ and Spring Boot 3.x for the server adapter.

## Modules

| Module | Artifact | Description |
|--------|----------|-------------|
| `autonoma-sdk` | `ai.autonoma:autonoma-sdk` | Core protocol (HMAC, refs, graph, handler) |
| `autonoma-spring` | `ai.autonoma:autonoma-spring` | Spring Boot server adapter |
| `conformance-bridge` | `ai.autonoma:autonoma-conformance-bridge` | Conformance test bridge (internal) |

## Quick Start

### Install

Add to your `pom.xml`:

```xml
<dependency>
    <groupId>ai.autonoma</groupId>
    <artifactId>autonoma-sdk</artifactId>
    <version>0.2.0</version>
</dependency>
<dependency>
    <groupId>ai.autonoma</groupId>
    <artifactId>autonoma-spring</artifactId>
    <version>0.2.0</version>
</dependency>
```

### Spring Boot

```java
@Configuration
public class AutonomaConfig {
    @Bean
    public AutonomaController autonomaController() {
        Map<String, FactoryDefinition> factories = Map.of(
            "Organization", Factory.define(
                (data, ctx) -> Map.of("id", UUID.randomUUID().toString(), "name", data.get("name")),
                List.of(new FieldInfo("name", "string", true)),
                (record, ctx) -> deleteOrganization(record.get("id"))
            )
        );

        HandlerConfig config = new HandlerConfig(
            "organizationId",
            System.getenv("AUTONOMA_SHARED_SECRET"),
            System.getenv("AUTONOMA_SIGNING_SECRET"),
            (user, context) -> AuthResult.ofHeaders(
                Map.of("Authorization", "Bearer " + createToken(user))
            ),
            factories
        );
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
