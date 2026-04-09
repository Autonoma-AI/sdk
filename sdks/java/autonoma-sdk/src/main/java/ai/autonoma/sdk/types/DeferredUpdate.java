package ai.autonoma.sdk.types;

public record DeferredUpdate(
    String targetTempId,
    String model,
    String field,
    String refAlias
) {}
