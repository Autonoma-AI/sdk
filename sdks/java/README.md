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
            (user, context) -> AuthResult.ofHeaders(
                Map.of("Authorization", "Bearer " + createToken(user))
            )
        );
        config.setDialect("postgres");
        return new AutonomaController(config);
    }
}
```

The controller registers a POST endpoint at `/api/autonoma` (configurable via `autonoma.endpoint` property).

## Model name ↔ table name

By default, the SDK derives a model name from each SQL table by splitting on `_` and PascalCasing each part — **no pluralization**. Examples:

| SQL table | Auto-derived model name |
|-----------|-------------------------|
| `user` | `User` |
| `api_key` | `ApiKey` |
| `branch_deployment` | `BranchDeployment` |
| `organizations` | `Organizations` (stays plural) |
| `api_keys` | `ApiKeys` (stays plural) |

If every factory you register is keyed under the auto-derived name, **omit `tableNameMap` entirely** (leave it `null`). The SDK handles the mapping.

You only need `tableNameMap` when a factory key disagrees with the auto-derived name. Common reasons:

- Your tables are plural but you want singular factory keys: `organizations` table ↔ `"Organization"` key.
- Legacy short names: `usr` table ↔ `"User"` key, `acl` table ↔ `"AccessControl"` key.

The map is **sparse, not exhaustive**: only list entries that actually differ. Auto-derivation covers the rest.

```java
// Tables in DB: organization, user, api_key, deal   (singular)
// Factories keyed: "Organization", "User", "ApiKey", "Deal"
// tableNameMap left null — auto-derive is exact

// Tables in DB: organizations, users, api_keys
// Factories keyed singular → every entry disagrees:
config.setTableNameMap(Map.of(
    "Organization", "organizations",
    "User",         "users",
    "ApiKey",       "api_keys"
));
```

**Red flag:** if your `tableNameMap` has one entry per factory and every entry is just a plural↔singular rename, consider keeping factory keys plural (`"Organizations"`) and dropping the map entirely. Plural keys are valid — pick whichever convention your scenarios use.

## Commands

```bash
mvn compile                    # compile all modules
mvn test                       # run all tests
mvn test -pl autonoma-sdk      # test only core SDK
mvn package -DskipTests        # build JARs
```

## Documentation

For protocol-level documentation, see the root [`protocol/`](../../protocol/) directory.
