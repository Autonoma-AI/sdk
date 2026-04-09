package ai.autonoma.sdk.types;

public record FKEdge(
    String from,
    String to,
    String localField,
    String foreignField,
    boolean nullable
) {}
