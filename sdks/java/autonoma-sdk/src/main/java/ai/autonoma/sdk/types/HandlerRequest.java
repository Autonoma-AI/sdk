package ai.autonoma.sdk.types;

import java.util.Map;

public record HandlerRequest(
    String body,
    Map<String, String> headers
) {}
