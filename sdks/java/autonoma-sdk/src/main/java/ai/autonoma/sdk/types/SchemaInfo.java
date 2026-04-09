package ai.autonoma.sdk.types;

import java.util.List;

public record SchemaInfo(
    List<ModelInfo> models,
    List<FKEdge> edges,
    List<SchemaRelation> relations,
    String scopeField
) {}
