package ai.autonoma.sdk.types;

import java.util.List;

public record ModelInfo(
    String name,
    List<FieldInfo> fields
) {}
