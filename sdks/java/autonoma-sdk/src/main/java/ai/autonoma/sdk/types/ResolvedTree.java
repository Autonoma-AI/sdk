package ai.autonoma.sdk.types;

import java.util.List;
import java.util.Map;

public record ResolvedTree(
    List<CreateOp> ops,
    Map<String, String> aliases,
    Map<String, String> aliasOwnerModel,
    Map<String, List<String>> aliasDependencies
) {}
