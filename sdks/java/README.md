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
// AutonomaConfig.java
@Configuration
public class AutonomaConfig {
    // An input class describes a model's create fields; the SDK derives the
    // discover schema from it by reflection, so there is no FieldInfo list.
    public static class OrganizationInput { public String name; }

    @Bean
    public AutonomaController autonomaController() {
        Map<String, FactoryDefinition> factories = Map.of(
            "Organization", FactoryUtil.defineFactory(
                (data, ctx) -> {
                    OrganizationInput input = (OrganizationInput) data;
                    return Map.of("id", createOrganization(input.name), "name", input.name);
                },
                OrganizationInput.class,
                (record, ctx) -> deleteOrganization((String) record.get("id"))
            )
        );

        HandlerConfig config = new HandlerConfig(
            "organizationId",
            System.getenv("AUTONOMA_SHARED_SECRET"),
            System.getenv("AUTONOMA_SIGNING_SECRET"),
            (user, context) -> AuthResult.ofHeaders(
                Map.of("Authorization", "Bearer " + createToken(user))
            )
        ).setFactories(factories).setAllowProduction(true);

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

Full agent-facing docs are bundled into the `autonoma-sdk` JAR under `autonoma/docs/` (and mirrored in this repo at [`autonoma-sdk/src/main/resources/autonoma/docs/`](./autonoma-sdk/src/main/resources/autonoma/docs/)); start with `implement.md`. For the language-agnostic wire protocol, see the root [`protocol/`](../../protocol/) directory.
