package ai.autonoma.sdk;

import ai.autonoma.sdk.types.*;

import java.util.*;

/**
 * Tear down all data scoped to a value, in reverse topological order.
 *
 * Strategy:
 *   1. Find the scope root model (e.g. Organization) from FK edges
 *   2. Any model with a FK pointing to the scope root is "scoped"
 *   3. Delete scoped models by their FK = scopeValue
 *   4. Delete non-scoped models by their record IDs from refs
 *   5. Delete the scope root entity last by id = scopeValue
 */
public final class TeardownExecutor {

    private TeardownExecutor() {}

    @SuppressWarnings("unchecked")
    public static void teardown(
            SQLExecutor executor,
            Dialect dialect,
            Map<String, String> tableMap,
            Map<String, Map<String, String>> columnMaps,
            SchemaInfo schema,
            String scopeValue,
            Map<String, List<Map<String, Object>>> refs) {

        // Find scope root
        String scopeRootModel = null;
        for (FKEdge edge : schema.edges()) {
            if (edge.localField().equalsIgnoreCase(schema.scopeField()) && !edge.to().equals(edge.from())) {
                scopeRootModel = edge.to();
                break;
            }
        }

        // Build map: model -> FK field name pointing to scope root
        Map<String, String> scopeFieldByModel = new LinkedHashMap<>();
        if (scopeRootModel != null) {
            for (FKEdge edge : schema.edges()) {
                if (edge.to().equals(scopeRootModel) && !edge.from().equals(scopeRootModel)) {
                    scopeFieldByModel.put(edge.from(), edge.localField());
                }
            }
        }

        List<String> modelNames = schema.models().stream().map(ModelInfo::name).toList();
        TopoSortResult sortResult = GraphUtil.topoSort(modelNames, schema.edges());

        final String finalScopeRoot = scopeRootModel;

        executor.transaction(tx -> {
            // Break cycles by nullifying deferrable FKs
            for (List<String> cycle : sortResult.cycles()) {
                FKEdge edge = GraphUtil.findDeferrableEdge(cycle, schema.edges());
                if (edge != null) {
                    String scopeFK = scopeFieldByModel.get(edge.from());
                    if (scopeFK != null) {
                        String dbTable = tableMap.get(edge.from());
                        Map<String, String> colMap = columnMaps.getOrDefault(edge.from(), Map.of());
                        if (dbTable != null) {
                            String dbFKCol = colMap.getOrDefault(edge.localField(), edge.localField());
                            String dbScopeCol = colMap.getOrDefault(scopeFK, scopeFK);
                            tx.query("UPDATE " + dialect.quoteId(dbTable) + " SET " + dialect.quoteId(dbFKCol)
                                + " = NULL WHERE " + dialect.quoteId(dbScopeCol) + " = " + dialect.param(1), scopeValue);
                        }
                    }
                }
            }

            // Build condensation graph: each SCC is a super-node, each sorted node
            // is its own node. Topo-sort the condensation DAG and delete in reverse
            // order so that dependents of cycles are deleted before the cycle itself.
            List<List<String>> components = new ArrayList<>();
            Map<String, Integer> nodeToComp = new HashMap<>();

            for (List<String> cycle : sortResult.cycles()) {
                int idx = components.size();
                components.add(cycle);
                for (String node : cycle) nodeToComp.put(node, idx);
            }
            for (String node : sortResult.sorted()) {
                nodeToComp.put(node, components.size());
                components.add(List.of(node));
            }

            // Build condensation DAG edges (dependency → dependent)
            Map<Integer, Set<Integer>> condAdj = new HashMap<>();
            Map<Integer, Integer> condInDeg = new HashMap<>();
            for (int i = 0; i < components.size(); i++) {
                condAdj.put(i, new HashSet<>());
                condInDeg.put(i, 0);
            }
            for (FKEdge edge : schema.edges()) {
                if (edge.from().equals(edge.to())) continue;
                Integer fc = nodeToComp.get(edge.from());
                Integer tc = nodeToComp.get(edge.to());
                if (fc != null && tc != null && !fc.equals(tc) && !condAdj.get(tc).contains(fc)) {
                    condAdj.get(tc).add(fc);
                    condInDeg.merge(fc, 1, Integer::sum);
                }
            }

            // Kahn's algorithm on the condensation DAG
            List<Integer> condQueue = new ArrayList<>();
            for (var entry : condInDeg.entrySet()) {
                if (entry.getValue() == 0) condQueue.add(entry.getKey());
            }
            Collections.sort(condQueue);
            List<Integer> condOrder = new ArrayList<>();
            while (!condQueue.isEmpty()) {
                Collections.sort(condQueue);
                int idx = condQueue.remove(0);
                condOrder.add(idx);
                for (int neighbor : condAdj.get(idx)) {
                    int nd = condInDeg.merge(neighbor, -1, Integer::sum);
                    if (nd == 0) condQueue.add(neighbor);
                }
            }

            // Delete in reverse condensation order (dependents first)
            List<Integer> revCondOrder = new ArrayList<>(condOrder);
            Collections.reverse(revCondOrder);
            for (int compIdx : revCondOrder) {
                for (String model : components.get(compIdx)) {
                    if (model.equals(finalScopeRoot)) continue;
                    deleteModel(tx, dialect, tableMap, columnMaps, model, scopeValue, scopeFieldByModel, refs, schema);
                }
            }

            // Delete scope root last
            if (finalScopeRoot != null) {
                String dbTable = tableMap.get(finalScopeRoot);
                Map<String, String> colMap = columnMaps.getOrDefault(finalScopeRoot, Map.of());
                if (dbTable != null) {
                    ModelInfo rootModelInfo = schema.models().stream()
                        .filter(m -> m.name().equals(finalScopeRoot))
                        .findFirst().orElse(null);
                    // Composite PK: prefer field named "id"
                    List<FieldInfo> rootIdFields = rootModelInfo != null
                        ? rootModelInfo.fields().stream().filter(FieldInfo::isId).toList()
                        : List.of();
                    FieldInfo rootPkField = rootIdFields.stream()
                        .filter(f -> f.name().equalsIgnoreCase("id")).findFirst()
                        .orElse(rootIdFields.isEmpty() ? null : rootIdFields.get(0));
                    String rootPkFieldName = rootPkField != null ? rootPkField.name() : "id";
                    String idCol = colMap.getOrDefault(rootPkFieldName, rootPkFieldName);
                    tx.query("DELETE FROM " + dialect.quoteId(dbTable) + " WHERE " + dialect.quoteId(idCol)
                        + " = " + dialect.param(1), scopeValue);
                }
            }

            return null;
        });
    }

    private static void deleteModel(
            SQLExecutor tx,
            Dialect dialect,
            Map<String, String> tableMap,
            Map<String, Map<String, String>> columnMaps,
            String model,
            String scopeValue,
            Map<String, String> scopeFieldByModel,
            Map<String, List<Map<String, Object>>> refs,
            SchemaInfo schema) {

        String dbTable = tableMap.get(model);
        if (dbTable == null) return;
        Map<String, String> colMap = columnMaps.getOrDefault(model, Map.of());

        // Find actual PK field name from schema
        ModelInfo modelInfo = schema.models().stream()
            .filter(m -> m.name().equals(model))
            .findFirst().orElse(null);
        // When multiple isId fields exist (composite PK), prefer the one named "id"
        List<FieldInfo> idFields = modelInfo != null
            ? modelInfo.fields().stream().filter(FieldInfo::isId).toList()
            : List.of();
        FieldInfo pkField = idFields.stream().filter(f -> f.name().equalsIgnoreCase("id")).findFirst()
            .orElse(idFields.isEmpty() ? null : idFields.get(0));
        String pkFieldName = pkField != null ? pkField.name() : "id";

        String scopeFK = scopeFieldByModel.get(model);
        if (scopeFK != null) {
            String dbCol = colMap.getOrDefault(scopeFK, scopeFK);
            tx.query("DELETE FROM " + dialect.quoteId(dbTable) + " WHERE " + dialect.quoteId(dbCol)
                + " = " + dialect.param(1), scopeValue);
        } else if (refs != null && refs.containsKey(model)) {
            List<Object> ids = refs.get(model).stream()
                .map(r -> r.get(pkFieldName))
                .filter(Objects::nonNull)
                .toList();
            if (!ids.isEmpty()) {
                String idCol = colMap.getOrDefault(pkFieldName, pkFieldName);
                StringJoiner placeholders = new StringJoiner(", ");
                for (int idx = 0; idx < ids.size(); idx++) {
                    placeholders.add(dialect.param(idx + 1));
                }
                tx.query("DELETE FROM " + dialect.quoteId(dbTable) + " WHERE " + dialect.quoteId(idCol)
                    + " IN (" + placeholders + ")", ids.toArray());
            }
        }
    }
}
