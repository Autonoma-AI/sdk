# Validating scenarios (Java)

The Java SDK has no separate dry-run helper. Validate scenarios by driving `AutonomaHandler.handleRequest` through the same `up` and `down` lifecycle the platform uses. This exercises your real scenario code, token signing, and teardown without starting an HTTP server.

## A complete JUnit lifecycle

Build the same `HandlerConfig` your Spring controller uses, but point its application services at a disposable test database.

```java
import ai.autonoma.sdk.AutonomaHandler;
import ai.autonoma.sdk.HmacUtil;
import ai.autonoma.sdk.Scenario;
import ai.autonoma.sdk.UniqueUtil;
import ai.autonoma.sdk.types.HandlerConfig;
import ai.autonoma.sdk.types.HandlerRequest;
import ai.autonoma.sdk.types.HandlerResponse;
import ai.autonoma.sdk.types.ScenarioUpResult;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class ScenarioValidationTest {
  private static final String SHARED = "check-shared-secret";
  private static final String SIGNING = "check-signing-secret";
  private static final ObjectMapper JSON = new ObjectMapper();

  private HandlerConfig config() {
    var scenario = Scenario.define(
        "single-user",
        "One verified user",
        ctx -> {
          String email = UniqueUtil.uniqueEmail(ctx.testRunId(), null, null);
          User user = users.createVerified(email);
          return ScenarioUpResult.builder()
              .teardown(Map.of("userId", user.id()))
              .build();
        },
        ctx -> users.delete((String) ctx.teardown().get("userId")));

    return new HandlerConfig(SHARED, SIGNING, List.of(scenario));
  }

  private HandlerResponse post(HandlerConfig config, Map<String, Object> payload) throws Exception {
    String body = JSON.writeValueAsString(payload);
    String signature = HmacUtil.signBody(body, SHARED);
    return AutonomaHandler.handleRequest(config, new HandlerRequest(body, Map.of("x-signature", signature)));
  }

  @Test
  void scenarioRoundTrips() throws Exception {
    HandlerConfig config = config();

    HandlerResponse up = post(config, Map.of(
        "action", "up",
        "scenario", Map.of("name", "single-user"),
        "testRunId", "check-run-1"));

    assertEquals(200, up.status(), "up failed: " + up.body());
    String teardownToken = (String) up.body().get("teardownToken");
    assertNotNull(teardownToken);

    HandlerResponse down = post(config, Map.of(
        "action", "down",
        "teardownToken", teardownToken,
        "testRunId", "check-run-1"));

    assertEquals(200, down.status(), "down failed: " + down.body());
    assertEquals(true, down.body().get("ok"));
  }
}
```

Run the test against a real test schema. Testcontainers plus the application's normal migration path is the reliable choice when the project does not already provide an integration-test database.

## What to assert

- `discover` lists every scenario name and description.
- `up` returns `200` and a non-empty `teardownToken`.
- `down` accepts the token and returns `{ ok: true }`.
- A second run with a different `testRunId` does not collide with the first.
- Teardown removes every row the scenario created.

## Failure guide

| Signal | Cause | Fix |
|--------|-------|-----|
| `UNKNOWN_ENVIRONMENT` | The requested name is not registered | Add the scenario to `HandlerConfig`. |
| `INVALID_TEARDOWN_TOKEN` | The teardown token is missing, damaged, or verified with another signing secret | Reuse the same config and pass `teardownToken` unchanged. |
| `INTERNAL_ERROR` during up | Customer provisioning code threw | Fix the application service call or test database state. |
| `INTERNAL_ERROR` during down | Cleanup referenced missing state or used the wrong delete order | Return every cleanup handle from `up` and delete children before parents. |

Keep the fix loop simple: read `code` and `error`, fix the customer scenario, and rerun until both phases succeed.
