package ai.autonoma.sdk.types;

import java.util.Map;

public record IntrospectionResult(
    SchemaInfo schema,
    Map<String, String> tableMap,
    Map<String, Map<String, String>> columnMaps,
    Map<String, Map<String, String>> enumTypeMaps
) {}
