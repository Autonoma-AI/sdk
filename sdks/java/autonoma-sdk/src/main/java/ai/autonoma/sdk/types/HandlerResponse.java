package ai.autonoma.sdk.types;

import java.util.Map;

public record HandlerResponse(
    int status,
    Map<String, Object> body
) {}
