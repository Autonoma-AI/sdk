package ai.autonoma.sdk.types;

import java.util.List;
import java.util.Map;

/**
 * Context passed to factory create and teardown functions.
 */
public record FactoryContext(
    /** All refs created so far, keyed by model name. */
    Map<String, List<Map<String, Object>>> refs,
    /** The detected or fallback scope value. */
    String scenarioName,
    /** Unique ID for this test run. */
    String testRunId
) {}
