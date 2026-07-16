# Writing factories (Java)

A factory tells the SDK how to create and delete one model using your own code. You register one factory per model the platform can create, and pass them all to the handler as its `factories` map. This page is the exact contract; read it before writing any.

## The shape

```java
// src/main/java/com/example/factories/OrganizationFactory.java
import ai.autonoma.sdk.FactoryUtil;
import ai.autonoma.sdk.types.FactoryDefinition;
import java.util.LinkedHashMap;
import java.util.Map;

public final class OrganizationFactory {

  // Input model: its fields define the discover schema and are validated before create.
  public static class Input {
    public String name;
    public String slug;
  }

  public static FactoryDefinition define(OrganizationService service) {
    return FactoryUtil.defineFactory(
      (data, ctx) -> {                          // create
        Input input = (Input) data;
        Organization org = service.create(input.name, input.slug);
        Map<String, Object> record = new LinkedHashMap<>();
        record.put("id", org.getId());
        record.put("name", org.getName());
        return record;
      },
      Input.class,                              // inputClass (required)
      (record, ctx) -> {                        // teardown (optional)
        @SuppressWarnings("unchecked")
        Map<String, Object> r = (Map<String, Object>) record;
        service.delete((String) r.get("id"));
      }
    );
  }
}
```

`FactoryUtil.defineFactory(...)` builds a `FactoryDefinition`. It has three overloads:

| Signature | Use when |
|-----------|----------|
| `defineFactory(create, inputClass)` | Create only, no teardown. |
| `defineFactory(create, inputClass, teardown)` | Create plus teardown. |
| `defineFactory(create, inputClass, teardown, refClass)` | Also convert the stored record to a typed `refClass` before teardown. |

`create` must not be null and `inputClass` must not be null - the SDK throws `IllegalArgumentException` at construction otherwise.

## inputClass (required)

A plain Java class (POJO) whose public fields describe the fields this model accepts in the create payload. It does two jobs:

1. The SDK validates each incoming record against it - `ObjectMapper.convertValue(data, inputClass)` - before calling `create`, then hands your `create` the typed instance (as `Object`; cast it).
2. The SDK derives the discover schema from it via reflection - there is no database introspection, so this class is how the platform learns your model exists and what fields it has.

Field types map to the wire schema coarsely: `String` and `UUID` become `string`/`uuid`, `int`/`Integer`/`long`/`Long` become `integer`, `double`/`float`/`BigDecimal` become `number`, `boolean` becomes `boolean`, `Instant`/`LocalDateTime` become `timestamp`, `LocalDate` becomes `date`, and arrays/collections/maps become `json`. A synthetic `id` field is always added at the head of every model.

Use Jackson's `@JsonProperty` when the wire field name differs from the Java field name (for example snake_case JSON):

```java
// src/main/java/com/example/factories/UserFactory.java
import com.fasterxml.jackson.annotation.JsonProperty;

public static class Input {
  public String name;
  public String email;
  @JsonProperty("organization_id")
  public String organizationId;   // arrives as the real Organization id, not a _ref
}
```

**Include every foreign key in the input class, including the scope field.** By the time `create` runs, the SDK has already resolved every `_ref` to the real ID of the referenced record, so a FK arrives as a plain value.

## create(data, ctx)

Creates exactly one record and returns it.

- `data` - the validated input, an instance of your `inputClass`. Cast it: `Input input = (Input) data;`. FK fields are already real IDs.
- `ctx` - a `FactoryContext` record with `refs()`, `scenarioName()`, and `testRunId()`. `refs()` holds everything created so far this run (`Map<String, List<Map<String, Object>>>`, keyed by model) if you need to look something up.
- **Return value** - a `Map<String, Object>` that must include at least the primary key `id`. If `create` returns `null` or a map without `id`, the SDK fails the request with `FACTORY_MISSING_PK` (status 500). Everything you return is stored in `refs`, passed to the auth callback, and later handed to `teardown` - so return whatever teardown or auth will need (typically the id, plus fields like `email`).

`create` may `throw` a checked exception; the SDK wraps it and fails the `up` request. Reuse your application's real creation path (a service method, repository, or the same code your signup controller calls). That is the entire point: the test user gets the same password hash, defaults, and side effects a real user would.

## teardown(record, ctx) - optional

Deletes one record. The SDK calls it once per created record, in reverse dependency order, during `down`.

- `record` - by default, exactly the `Map<String, Object>` your `create` returned (cast it). If you set `refClass`, the SDK converts the stored record to that type first and passes the typed instance instead.
- If you omit `teardown` (pass the two-argument overload), the model is never deleted on `down` - there is no SQL fallback. Provide a teardown for every model you create, or those rows leak.

```java
// src/main/java/com/example/factories/UserFactory.java
(record, ctx) -> {
  @SuppressWarnings("unchecked")
  Map<String, Object> r = (Map<String, Object>) record;
  userService.delete((String) r.get("id"));
}
```

## refClass - optional

A typed class for the record `create` returns. When you pass it as the fourth argument to `defineFactory`, the SDK converts the stored record through `ObjectMapper.convertValue(record, refClass)` before `teardown`, so your teardown receives a typed object instead of a raw map (no casts needed). If the conversion fails, the SDK falls back to passing the raw map.

```java
// src/main/java/com/example/factories/UserFactory.java
public static class Ref {
  public String id;
  public String email;
}

FactoryUtil.defineFactory(
  (data, ctx) -> { /* ... returns Map with id + email ... */ },
  Input.class,
  (record, ctx) -> {
    Ref ref = (Ref) record;
    userService.delete(ref.id);   // ref.id is a typed String
  },
  Ref.class
);
```

## Registering factories

Collect every factory into one `Map<String, FactoryDefinition>` keyed by model name - the key must match the model name the platform sends in `create`:

```java
// src/main/java/com/example/AutonomaConfig.java
Map<String, FactoryDefinition> factories = Map.of(
  "Organization", OrganizationFactory.define(organizationService),
  "User",         UserFactory.define(userService),
  "Member",       MemberFactory.define(memberService)
);
```

Attach that map to the `HandlerConfig` with `setFactories(factories)` (see `implement.md`). Every model that appears in a scenario must have an entry here, or the `up` request fails with `INVALID_BODY` ("no factory registered for model ...").
