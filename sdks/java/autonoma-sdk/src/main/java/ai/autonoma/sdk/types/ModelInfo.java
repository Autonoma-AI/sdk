package ai.autonoma.sdk.types;

import java.util.List;

public record ModelInfo(
    String name,
    String tableName,
    List<FieldInfo> fields
) {}
