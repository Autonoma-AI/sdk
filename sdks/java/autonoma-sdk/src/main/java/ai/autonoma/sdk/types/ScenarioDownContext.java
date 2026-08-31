package ai.autonoma.sdk.types;

import java.util.Map;

/**
 * Context passed to a scenario's {@code down}.
 *
 * @param name      the scenario name, recovered from the verified teardown token
 * @param teardown  the {@code teardown} handle this scenario returned from {@code up}
 * @param testRunId the {@code testRunId} captured at {@code up} time
 */
public record ScenarioDownContext(
    String name,
    Map<String, Object> teardown,
    String testRunId
) {}
