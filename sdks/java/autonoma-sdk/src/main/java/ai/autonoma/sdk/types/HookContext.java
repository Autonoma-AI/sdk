package ai.autonoma.sdk.types;

import java.util.List;
import java.util.Map;

/**
 * Context passed to handler hooks (beforeDown, afterUp).
 */
public record HookContext(
    String scenarioName,
    Map<String, List<Map<String, Object>>> refs
) {}
