package ai.autonoma.sdk.types;

import java.util.Map;

public record CreateOp(
    String model,
    Map<String, Object> fields,
    String tempId,
    boolean batch
) {}
