package ai.autonoma.sdk;

import ai.autonoma.sdk.types.CreateOp;
import ai.autonoma.sdk.types.ResolvedTree;

import java.util.*;

/**
 * Resolve the create payload into an ordered list of operations.
 *
 * <p>Ordering comes from the payload's {@code _alias}/{@code _ref} graph.
 * Each entity that others depend on declares {@code _alias: "name"}.
 * Each entity that depends on another carries {@code {"_ref": "name"}}
 * somewhere in its field tree. Walking the payload to collect these gives
 * the exact dependency graph. Kahn's topo sort produces the up order;
 * the reverse is the down order.
 */
public final class PayloadTopo {

    private static final Set<String> RESERVED_KEYS = Set.of("_alias", "_ref");

    private PayloadTopo() {}

    /**
     * Topo-sort a create payload into an ordered list of CreateOp.
     *
     * @param create the dashboard's nested map {model: [entity, ...]}
     * @return a ResolvedTree with ops in topological order
     */
    @SuppressWarnings("unchecked")
    public static ResolvedTree resolvePayloadTree(Map<String, Object> create) {
        if (create == null) {
            throw AutonomaError.invalidBody("`create` must be an object keyed by model name");
        }

        // First pass: assign temp ids and collect alias declarations.
        List<RawEntry> rawEntries = new ArrayList<>();
        int counter = 0;
        Map<String, String> aliases = new LinkedHashMap<>();
        Map<String, String> aliasOwnerModel = new LinkedHashMap<>();

        for (Map.Entry<String, Object> modelEntry : create.entrySet()) {
            String model = modelEntry.getKey();
            Object entitiesRaw = modelEntry.getValue();
            if (!(entitiesRaw instanceof List<?>)) {
                throw AutonomaError.invalidBody(
                    "`create." + model + "` must be a list of entity objects, got " + entitiesRaw.getClass().getSimpleName());
            }
            List<?> entities = (List<?>) entitiesRaw;
            for (Object entityRaw : entities) {
                if (!(entityRaw instanceof Map<?, ?>)) {
                    throw AutonomaError.invalidBody(
                        "`create." + model + "` entries must be objects, got " + entityRaw.getClass().getSimpleName());
                }
                Map<String, Object> entity = (Map<String, Object>) entityRaw;
                String tempId = "__temp_" + model + "_" + counter;
                counter++;

                Object aliasRaw = entity.get("_alias");
                String alias = null;
                if (aliasRaw instanceof String a) {
                    if (aliases.containsKey(a)) {
                        throw AutonomaError.invalidBody("duplicate _alias \"" + a + "\"");
                    }
                    aliases.put(a, tempId);
                    aliasOwnerModel.put(a, model);
                    alias = a;
                } else if (aliasRaw != null) {
                    throw AutonomaError.invalidBody("\"_alias\" must be a string");
                }

                rawEntries.add(new RawEntry(model, tempId, entity, alias));
            }
        }

        // Second pass: collect each entry's dependency aliases and strip reserved keys.
        Map<String, List<String>> depsByTempId = new LinkedHashMap<>();
        Map<String, Map<String, Object>> fieldsByTempId = new LinkedHashMap<>();
        Map<String, String> modelByTempId = new LinkedHashMap<>();
        Map<String, String> aliasByTempId = new LinkedHashMap<>();

        for (RawEntry entry : rawEntries) {
            List<String> deps = new ArrayList<>();
            Map<String, Object> cleaned = new LinkedHashMap<>();
            for (Map.Entry<String, Object> kv : entry.entity.entrySet()) {
                if (RESERVED_KEYS.contains(kv.getKey())) continue;
                collectRefs(kv.getValue(), deps);
                cleaned.put(kv.getKey(), resolveRefs(kv.getValue(), aliases));
            }
            List<String> unknown = new ArrayList<>();
            for (String a : deps) {
                if (!aliases.containsKey(a)) unknown.add(a);
            }
            if (!unknown.isEmpty()) {
                Set<String> uniqueUnknown = new TreeSet<>(unknown);
                throw AutonomaError.invalidBody(
                    "`create." + entry.model + "` references unknown alias(es): " + String.join(", ", uniqueUnknown));
            }
            depsByTempId.put(entry.tempId, deps);
            fieldsByTempId.put(entry.tempId, cleaned);
            modelByTempId.put(entry.tempId, entry.model);
            aliasByTempId.put(entry.tempId, entry.alias);
        }

        // Build the temp_id graph and topo-sort.
        Map<String, Integer> inDegree = new LinkedHashMap<>();
        for (RawEntry entry : rawEntries) {
            inDegree.put(entry.tempId, 0);
        }
        Map<String, List<String>> edges = new LinkedHashMap<>();

        for (Map.Entry<String, List<String>> entry : depsByTempId.entrySet()) {
            String tempId = entry.getKey();
            Set<String> seen = new HashSet<>();
            for (String depAlias : entry.getValue()) {
                String depTempId = aliases.get(depAlias);
                if (depTempId.equals(tempId) || seen.contains(depTempId)) continue;
                seen.add(depTempId);
                edges.computeIfAbsent(depTempId, k -> new ArrayList<>()).add(tempId);
                inDegree.merge(tempId, 1, Integer::sum);
            }
        }

        // Kahn's, preserving payload order as stable tie-breaker.
        Map<String, Integer> payloadOrder = new LinkedHashMap<>();
        for (int i = 0; i < rawEntries.size(); i++) {
            payloadOrder.put(rawEntries.get(i).tempId, i);
        }

        List<String> ready = new ArrayList<>();
        for (Map.Entry<String, Integer> e : inDegree.entrySet()) {
            if (e.getValue() == 0) ready.add(e.getKey());
        }
        ready.sort(Comparator.comparingInt(t -> payloadOrder.getOrDefault(t, 0)));

        List<String> sortedTempIds = new ArrayList<>();
        while (!ready.isEmpty()) {
            String tid = ready.remove(0);
            sortedTempIds.add(tid);
            for (String nxt : edges.getOrDefault(tid, List.of())) {
                int newDeg = inDegree.get(nxt) - 1;
                inDegree.put(nxt, newDeg);
                if (newDeg == 0) ready.add(nxt);
            }
            ready.sort(Comparator.comparingInt(t -> payloadOrder.getOrDefault(t, 0)));
        }

        if (sortedTempIds.size() != rawEntries.size()) {
            List<String> cycle = new ArrayList<>();
            for (Map.Entry<String, Integer> e : inDegree.entrySet()) {
                if (e.getValue() > 0) cycle.add(e.getKey());
            }
            cycle.sort(Comparator.comparingInt(t -> payloadOrder.getOrDefault(t, 0)));
            StringJoiner cycleModels = new StringJoiner(", ");
            for (String t : cycle) cycleModels.add(modelByTempId.get(t));
            throw AutonomaError.invalidBody("cycle detected in _alias/_ref graph: " + cycleModels);
        }

        // Build CreateOp list and alias dependencies.
        Map<String, List<String>> aliasDependencies = new LinkedHashMap<>();
        for (String alias : aliases.keySet()) {
            String tid = aliases.get(alias);
            aliasDependencies.put(alias, new ArrayList<>(depsByTempId.getOrDefault(tid, List.of())));
        }

        List<CreateOp> ops = new ArrayList<>();
        for (String tid : sortedTempIds) {
            ops.add(new CreateOp(modelByTempId.get(tid), fieldsByTempId.get(tid), tid));
        }

        return new ResolvedTree(ops, aliases, aliasOwnerModel, aliasDependencies);
    }

    /**
     * Compute model teardown order from alias dependency info in the refs token.
     */
    @SuppressWarnings("unchecked")
    public static List<String> computeTeardownOrder(
            Map<String, List<Map<String, Object>>> refs,
            Map<String, Object> aliasDependenciesRaw,
            Map<String, Object> aliasOwnerModelRaw) {

        List<String> models = new ArrayList<>(refs.keySet());

        if (aliasDependenciesRaw == null || aliasDependenciesRaw.isEmpty()
                || aliasOwnerModelRaw == null || aliasOwnerModelRaw.isEmpty()) {
            List<String> reversed = new ArrayList<>(models);
            Collections.reverse(reversed);
            return reversed;
        }

        // Convert raw maps to typed maps
        Map<String, List<String>> aliasDependencies = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : aliasDependenciesRaw.entrySet()) {
            List<String> deps = new ArrayList<>();
            if (e.getValue() instanceof List<?> list) {
                for (Object item : list) deps.add(item.toString());
            }
            aliasDependencies.put(e.getKey(), deps);
        }
        Map<String, String> aliasOwnerModel = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : aliasOwnerModelRaw.entrySet()) {
            aliasOwnerModel.put(e.getKey(), e.getValue().toString());
        }

        // Build model -> {model dependencies}
        Map<String, Set<String>> modelDeps = new LinkedHashMap<>();
        for (String m : models) modelDeps.put(m, new LinkedHashSet<>());

        for (Map.Entry<String, List<String>> entry : aliasDependencies.entrySet()) {
            String alias = entry.getKey();
            String owner = aliasOwnerModel.get(alias);
            if (owner == null || !modelDeps.containsKey(owner)) continue;
            for (String depAlias : entry.getValue()) {
                String depModel = aliasOwnerModel.get(depAlias);
                if (depModel == null || depModel.equals(owner)) continue;
                if (modelDeps.containsKey(depModel)) {
                    modelDeps.get(owner).add(depModel);
                }
            }
        }

        // Kahn's over models.
        Map<String, Integer> inDegree = new LinkedHashMap<>();
        Map<String, List<String>> adj = new LinkedHashMap<>();
        for (String m : models) {
            inDegree.put(m, 0);
            adj.put(m, new ArrayList<>());
        }
        for (Map.Entry<String, Set<String>> entry : modelDeps.entrySet()) {
            String owner = entry.getKey();
            for (String depModel : entry.getValue()) {
                adj.get(depModel).add(owner);
                inDegree.merge(owner, 1, Integer::sum);
            }
        }

        Map<String, Integer> payloadOrder = new LinkedHashMap<>();
        for (int i = 0; i < models.size(); i++) payloadOrder.put(models.get(i), i);

        List<String> ready = new ArrayList<>();
        for (Map.Entry<String, Integer> e : inDegree.entrySet()) {
            if (e.getValue() == 0) ready.add(e.getKey());
        }
        ready.sort(Comparator.comparingInt(m -> payloadOrder.getOrDefault(m, 0)));

        List<String> upOrder = new ArrayList<>();
        while (!ready.isEmpty()) {
            String m = ready.remove(0);
            upOrder.add(m);
            for (String nxt : adj.getOrDefault(m, List.of())) {
                int newDeg = inDegree.get(nxt) - 1;
                inDegree.put(nxt, newDeg);
                if (newDeg == 0) ready.add(nxt);
            }
            ready.sort(Comparator.comparingInt(mm -> payloadOrder.getOrDefault(mm, 0)));
        }

        if (upOrder.size() != models.size()) {
            // Shouldn't happen - cycles were rejected at up. Fall back.
            List<String> reversed = new ArrayList<>(models);
            Collections.reverse(reversed);
            return reversed;
        }

        List<String> result = new ArrayList<>(upOrder);
        Collections.reverse(result);
        return result;
    }

    // --- internal helpers ---

    @SuppressWarnings("unchecked")
    private static void collectRefs(Object value, List<String> out) {
        if (value instanceof Map<?, ?> map) {
            Object ref = map.get("_ref");
            if (ref instanceof String s) {
                out.add(s);
                return;
            }
            for (Object v : map.values()) collectRefs(v, out);
        } else if (value instanceof List<?> list) {
            for (Object v : list) collectRefs(v, out);
        }
    }

    @SuppressWarnings("unchecked")
    private static Object resolveRefs(Object value, Map<String, String> aliasToTempId) {
        if (value instanceof Map<?, ?> map) {
            Object ref = map.get("_ref");
            if (ref instanceof String s) {
                String real = aliasToTempId.get(s);
                return real != null ? real : value;
            }
            Map<String, Object> result = new LinkedHashMap<>();
            for (Map.Entry<?, ?> e : map.entrySet()) {
                result.put((String) e.getKey(), resolveRefs(e.getValue(), aliasToTempId));
            }
            return result;
        }
        if (value instanceof List<?> list) {
            List<Object> result = new ArrayList<>(list.size());
            for (Object v : list) result.add(resolveRefs(v, aliasToTempId));
            return result;
        }
        return value;
    }

    private record RawEntry(String model, String tempId, Map<String, Object> entity, String alias) {}
}
