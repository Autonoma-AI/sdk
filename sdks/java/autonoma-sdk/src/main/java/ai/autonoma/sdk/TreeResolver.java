package ai.autonoma.sdk;

import ai.autonoma.sdk.types.*;

import java.util.*;

/**
 * Resolves a nested scenario tree into an ordered list of create operations.
 *
 * Walks depth-first. Parent-child FKs are wired automatically.
 * Handles both directions:
 *   - FK on child (Application.organizationId -> Organization): set child FK to parent ID
 *   - FK on parent (Member.userId -> User): create child first, set parent FK to child ID
 *
 * Circular FK cycles are handled transparently: the nullable FK is omitted on the first
 * create and emitted as a DeferredUpdate to be applied via UPDATE after all records exist.
 */
public final class TreeResolver {

    private static final Set<String> RESERVED_KEYS = Set.of("_alias", "_ref");

    private TreeResolver() {}

    @SuppressWarnings("unchecked")
    public static ResolvedTree resolveTree(
            Map<String, List<Map<String, Object>>> create,
            SchemaInfo schema) {

        Map<String, SchemaRelation> relationByParentField = new HashMap<>();
        for (SchemaRelation rel : schema.relations()) {
            relationByParentField.put(rel.parentModel() + "." + rel.parentField(), rel);
        }

        // Determine FK direction for each relation
        Set<String> fkOnParent = new HashSet<>();
        for (SchemaRelation rel : schema.relations()) {
            for (FKEdge edge : schema.edges()) {
                if (edge.localField().equals(rel.childField())
                    && (edge.from().equals(rel.parentModel()) || edge.from().equals(rel.childModel()))) {
                    if (edge.from().equals(rel.parentModel())) {
                        fkOnParent.add(rel.parentModel() + "." + rel.parentField());
                    }
                    break;
                }
            }
        }

        Map<String, String> aliases = new LinkedHashMap<>();
        List<CreateOp> ops = new ArrayList<>();
        List<DeferredUpdate> deferredUpdates = new ArrayList<>();
        int[] tempCounter = {0};

        for (var entry : create.entrySet()) {
            String modelName = entry.getKey();
            List<Map<String, Object>> nodes = entry.getValue();
            for (int i = 0; i < nodes.size(); i++) {
                walkNode(modelName, nodes.get(i), null, null, false,
                    schema, relationByParentField, fkOnParent, aliases, ops, deferredUpdates, tempCounter);
            }
        }

        return new ResolvedTree(ops, deferredUpdates, aliases);
    }

    @SuppressWarnings("unchecked")
    private static String walkNode(
            String modelName,
            Map<String, Object> node,
            String parentTempId,
            SchemaRelation parentRelation,
            boolean parentFkOnParent,
            SchemaInfo schema,
            Map<String, SchemaRelation> relationByParentField,
            Set<String> fkOnParent,
            Map<String, String> aliases,
            List<CreateOp> ops,
            List<DeferredUpdate> deferredUpdates,
            int[] tempCounter) {

        Map<String, Object> fields = new LinkedHashMap<>();
        record ChildEntry(SchemaRelation relation, Object value, boolean fkOnParent) {}
        List<ChildEntry> preChildren = new ArrayList<>();
        List<ChildEntry> postChildren = new ArrayList<>();
        String alias = node.containsKey("_alias") ? String.valueOf(node.get("_alias")) : null;
        String tempId = "__temp_" + modelName + "_" + (tempCounter[0]++);

        for (var entry : node.entrySet()) {
            String key = entry.getKey();
            Object value = entry.getValue();

            if (RESERVED_KEYS.contains(key)) continue;

            // Look up relation by exact key, then try fallbacks
            String exactKey = modelName + "." + key;
            String prefixedKey = modelName + "." +
                Character.toLowerCase(modelName.charAt(0)) + modelName.substring(1) +
                Character.toUpperCase(key.charAt(0)) + key.substring(1);
            SchemaRelation relation = relationByParentField.get(exactKey);
            String matchedKey = exactKey;
            if (relation == null) {
                relation = relationByParentField.get(prefixedKey);
                matchedKey = prefixedKey;
            }
            if (relation == null) {
                // Fallback: match by child model name (PascalCase keys)
                for (var relEntry : relationByParentField.entrySet()) {
                    if (relEntry.getKey().startsWith(modelName + ".")
                        && relEntry.getValue().childModel().equalsIgnoreCase(key)) {
                        relation = relEntry.getValue();
                        matchedKey = relEntry.getKey();
                        break;
                    }
                }
            }
            if (relation != null) {
                boolean isOnParent = fkOnParent.contains(matchedKey);
                if (isOnParent) {
                    preChildren.add(new ChildEntry(relation, value, true));
                } else {
                    postChildren.add(new ChildEntry(relation, value, false));
                }
                continue;
            }

            // Handle _ref nodes
            if (value instanceof Map<?, ?> refMap && refMap.containsKey("_ref")) {
                String refAlias = String.valueOf(refMap.get("_ref"));
                String refTempId = aliases.get(refAlias);
                if (refTempId == null) {
                    deferredUpdates.add(new DeferredUpdate(tempId, modelName, key, refAlias));
                    continue;
                }
                fields.put(key, refTempId);
                continue;
            }

            fields.put(key, value);
        }

        // Wire FK to parent (if this node is a child and FK is on the child)
        if (parentRelation != null && parentTempId != null && !parentFkOnParent) {
            fields.put(parentRelation.childField(), parentTempId);
        }

        // Process pre-children: these need to be created BEFORE this node
        for (ChildEntry child : preChildren) {
            if (child.value instanceof List<?> list) {
                for (int i = 0; i < list.size(); i++) {
                    String childTempId = walkNode(
                        child.relation.childModel(), (Map<String, Object>) list.get(i),
                        tempId, child.relation, true,
                        schema, relationByParentField, fkOnParent, aliases, ops, deferredUpdates, tempCounter);
                    fields.put(child.relation.childField(), childTempId);
                }
            }
        }

        // Create this node
        ops.add(new CreateOp(modelName, fields, tempId, false));
        if (alias != null) aliases.put(alias, tempId);

        // Process post-children: normal case, FK is on the child
        for (ChildEntry child : postChildren) {
            if (child.value instanceof List<?> list) {
                for (int i = 0; i < list.size(); i++) {
                    walkNode(child.relation.childModel(), (Map<String, Object>) list.get(i),
                        tempId, child.relation, false,
                        schema, relationByParentField, fkOnParent, aliases, ops, deferredUpdates, tempCounter);
                }
            }
        }

        return tempId;
    }
}
