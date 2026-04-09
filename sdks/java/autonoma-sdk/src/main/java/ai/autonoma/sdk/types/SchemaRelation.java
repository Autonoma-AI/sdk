package ai.autonoma.sdk.types;

public record SchemaRelation(
    String parentModel,
    String childModel,
    String parentField,
    String childField
) {}
