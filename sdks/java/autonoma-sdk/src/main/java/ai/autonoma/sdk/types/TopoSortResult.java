package ai.autonoma.sdk.types;

import java.util.List;

public record TopoSortResult(
    List<String> sorted,
    List<List<String>> cycles
) {}
