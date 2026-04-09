package ai.autonoma.sdk.types;

import java.util.List;
import java.util.Map;

public record ResolvedTree(
    List<CreateOp> ops,
    List<DeferredUpdate> deferredUpdates,
    Map<String, String> aliases
) {}
