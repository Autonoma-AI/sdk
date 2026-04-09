package ai.autonoma.sdk.types;

public record FieldInfo(
    String name,
    String type,
    boolean isRequired,
    boolean isId,
    boolean hasDefault
) {}
