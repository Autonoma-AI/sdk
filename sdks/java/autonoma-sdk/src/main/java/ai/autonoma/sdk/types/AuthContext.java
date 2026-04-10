package ai.autonoma.sdk.types;

import java.util.List;
import java.util.Map;

/**
 * Context passed to the auth callback alongside the user record.
 */
public record AuthContext(
    String scopeValue,
    Map<String, List<Map<String, Object>>> refs
) {}
