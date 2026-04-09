package ai.autonoma.sdk;

import ai.autonoma.sdk.types.SQLExecutor;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.*;

/**
 * Create entities via raw SQL INSERT.
 *
 * Entities arrive pre-sorted by FK order (handler does topo-sort via TreeResolver).
 * Each model in spec is inserted sequentially; within a model, batch mode
 * uses a single multi-row INSERT while normal mode inserts one row at a time.
 */
public final class EntityCreator {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private EntityCreator() {}

    public static Map<String, List<Map<String, Object>>> createEntities(
            SQLExecutor executor,
            Dialect dialect,
            Map<String, String> tableMap,
            Map<String, Map<String, String>> columnMaps,
            Map<String, Map<String, Object>> spec,
            Map<String, Map<String, String>> enumTypeMaps) {

        Map<String, List<Map<String, Object>>> results = new LinkedHashMap<>();

        for (var entry : spec.entrySet()) {
            String model = entry.getKey();
            Map<String, Object> entitySpec = entry.getValue();
            String dbTable = tableMap.get(model);
            if (dbTable == null) throw new RuntimeException("Unknown model \"" + model + "\". Not found in database tables.");

            Map<String, String> colMap = columnMaps.getOrDefault(model, Map.of());
            Map<String, String> enumTypeMap = enumTypeMaps != null ? enumTypeMaps.getOrDefault(model, Map.of()) : Map.of();

            @SuppressWarnings("unchecked")
            List<Map<String, Object>> fieldsList = (List<Map<String, Object>>) entitySpec.get("fields");
            boolean batch = Boolean.TRUE.equals(entitySpec.get("batch"));

            if (batch && !fieldsList.isEmpty()) {
                results.put(model, insertBatch(executor, dialect, dbTable, colMap, enumTypeMap, fieldsList));
            } else {
                List<Map<String, Object>> created = new ArrayList<>();
                for (Map<String, Object> fields : fieldsList) {
                    List<Map<String, Object>> records = insertOne(executor, dialect, dbTable, colMap, enumTypeMap, fields);
                    if (!records.isEmpty()) created.add(records.get(0));
                }
                results.put(model, created);
            }
        }

        return results;
    }

    /**
     * Update a single record by primary key. Used for circular FK backfill.
     */
    public static void updateEntity(
            SQLExecutor executor,
            Dialect dialect,
            Map<String, String> tableMap,
            Map<String, Map<String, String>> columnMaps,
            String model,
            String id,
            Map<String, Object> fields,
            Map<String, Map<String, String>> enumTypeMaps) {

        String dbTable = tableMap.get(model);
        if (dbTable == null) throw new RuntimeException("Unknown model \"" + model + "\" for update.");
        Map<String, String> colMap = columnMaps.getOrDefault(model, Map.of());
        Map<String, String> enumTypeMap = enumTypeMaps != null ? enumTypeMaps.getOrDefault(model, Map.of()) : Map.of();

        List<String> setClauses = new ArrayList<>();
        List<Object> params = new ArrayList<>();
        int paramIdx = 1;

        for (var entry : fields.entrySet()) {
            String dbCol = colMap.getOrDefault(entry.getKey(), entry.getKey());
            setClauses.add(dialect.quoteId(dbCol) + " = " + castParam(dialect, paramIdx, enumTypeMap, entry.getKey()));
            params.add(serializeValue(entry.getValue(), dialect));
            paramIdx++;
        }

        String idCol = colMap.getOrDefault("id", "id");
        params.add(id);

        String sql = "UPDATE " + dialect.quoteId(dbTable) + " SET " + String.join(", ", setClauses)
            + " WHERE " + dialect.quoteId(idCol) + " = " + dialect.param(paramIdx);
        executor.query(sql, params.toArray());
    }

    // --- Internal helpers ---

    private static List<Map<String, Object>> insertOne(
            SQLExecutor executor,
            Dialect dialect,
            String dbTable,
            Map<String, String> colMap,
            Map<String, String> enumTypeMap,
            Map<String, Object> fields) {

        // Generate client-side UUID when none provided and table has 'id' column
        String idFieldName = reverseGet(colMap, findIdCol(colMap));
        if (idFieldName != null && !fields.containsKey(idFieldName)) {
            fields = new LinkedHashMap<>(fields);
            fields.put(idFieldName, UUID.randomUUID().toString());
        }

        if (fields.isEmpty()) {
            String sql = "INSERT INTO " + dialect.quoteId(dbTable) + " DEFAULT VALUES RETURNING *";
            return mapRowsBack(executor.query(sql), colMap);
        }

        List<String> dbCols = new ArrayList<>();
        List<String> placeholders = new ArrayList<>();
        List<Object> params = new ArrayList<>();
        int paramIdx = 1;

        for (var entry : fields.entrySet()) {
            String dbCol = colMap.getOrDefault(entry.getKey(), entry.getKey());
            dbCols.add(dialect.quoteId(dbCol));
            placeholders.add(castParam(dialect, paramIdx, enumTypeMap, entry.getKey()));
            params.add(serializeValue(entry.getValue(), dialect));
            paramIdx++;
        }

        String colList = String.join(", ", dbCols);
        String valList = String.join(", ", placeholders);

        if (dialect.supportsReturning()) {
            String sql = "INSERT INTO " + dialect.quoteId(dbTable) + " (" + colList + ") VALUES (" + valList + ") RETURNING *";
            return mapRowsBack(executor.query(sql, params.toArray()), colMap);
        }

        // MySQL: INSERT then SELECT back
        executor.query("INSERT INTO " + dialect.quoteId(dbTable) + " (" + colList + ") VALUES (" + valList + ")", params.toArray());

        String idCol = findIdCol(colMap);
        Object id = fields.get(idFieldName != null ? idFieldName : "id");
        return mapRowsBack(
            executor.query("SELECT * FROM " + dialect.quoteId(dbTable) + " WHERE " + dialect.quoteId(idCol) + " = " + dialect.param(1), id),
            colMap
        );
    }

    private static List<Map<String, Object>> insertBatch(
            SQLExecutor executor,
            Dialect dialect,
            String dbTable,
            Map<String, String> colMap,
            Map<String, String> enumTypeMap,
            List<Map<String, Object>> fieldsArr) {

        if (fieldsArr.isEmpty()) return List.of();

        // Generate client-side IDs
        String idFieldName = reverseGet(colMap, findIdCol(colMap));
        if (idFieldName != null) {
            String finalIdFieldName = idFieldName;
            fieldsArr = fieldsArr.stream().map(fields -> {
                if (!fields.containsKey(finalIdFieldName)) {
                    Map<String, Object> copy = new LinkedHashMap<>(fields);
                    copy.put(finalIdFieldName, UUID.randomUUID().toString());
                    return copy;
                }
                return fields;
            }).toList();
        }

        List<String> fieldNames = new ArrayList<>(fieldsArr.get(0).keySet());
        List<String> dbCols = fieldNames.stream()
            .map(f -> dialect.quoteId(colMap.getOrDefault(f, f)))
            .toList();
        String colList = String.join(", ", dbCols);

        int maxParams = 32000;
        int chunkSize = Math.max(1, maxParams / fieldNames.size());
        List<Map<String, Object>> allResults = new ArrayList<>();

        for (int offset = 0; offset < fieldsArr.size(); offset += chunkSize) {
            List<Map<String, Object>> chunk = fieldsArr.subList(offset, Math.min(offset + chunkSize, fieldsArr.size()));
            List<Object> params = new ArrayList<>();
            List<String> valueTuples = new ArrayList<>();
            int paramIdx = 1;

            for (Map<String, Object> fields : chunk) {
                List<String> phList = new ArrayList<>();
                for (String fieldName : fieldNames) {
                    phList.add(castParam(dialect, paramIdx, enumTypeMap, fieldName));
                    params.add(serializeValue(fields.get(fieldName), dialect));
                    paramIdx++;
                }
                valueTuples.add("(" + String.join(", ", phList) + ")");
            }

            String valList = String.join(", ", valueTuples);

            if (dialect.supportsReturning()) {
                String sql = "INSERT INTO " + dialect.quoteId(dbTable) + " (" + colList + ") VALUES " + valList + " RETURNING *";
                allResults.addAll(mapRowsBack(executor.query(sql, params.toArray()), colMap));
            } else {
                executor.query("INSERT INTO " + dialect.quoteId(dbTable) + " (" + colList + ") VALUES " + valList, params.toArray());
            }
        }

        return allResults;
    }

    private static List<Map<String, Object>> mapRowsBack(List<Map<String, Object>> rows, Map<String, String> colMap) {
        if (colMap.isEmpty()) return rows;

        Map<String, String> reverse = new LinkedHashMap<>();
        for (var entry : colMap.entrySet()) {
            reverse.put(entry.getValue(), entry.getKey());
        }

        List<Map<String, Object>> result = new ArrayList<>(rows.size());
        for (Map<String, Object> row : rows) {
            Map<String, Object> mapped = new LinkedHashMap<>();
            for (var entry : row.entrySet()) {
                String fieldName = reverse.getOrDefault(entry.getKey(), entry.getKey());
                mapped.put(fieldName, entry.getValue());
            }
            result.add(mapped);
        }
        return result;
    }

    private static String findIdCol(Map<String, String> colMap) {
        return colMap.getOrDefault("id", "id");
    }

    private static String reverseGet(Map<String, String> map, String dbName) {
        for (var entry : map.entrySet()) {
            if (entry.getValue().equals(dbName)) return entry.getKey();
        }
        return null;
    }

    private static String castParam(Dialect dialect, int paramIdx, Map<String, String> enumTypeMap, String fieldName) {
        String placeholder = dialect.param(paramIdx);
        if ("postgres".equals(dialect.name())) {
            String enumType = enumTypeMap.get(fieldName);
            if (enumType != null) return placeholder + "::" + dialect.quoteId(enumType);
        }
        return placeholder;
    }

    @SuppressWarnings("unchecked")
    private static Object serializeValue(Object value, Dialect dialect) {
        if (value == null) return null;

        // JSON: stringify maps and lists
        if (value instanceof Map || value instanceof List) {
            try {
                return MAPPER.writeValueAsString(value);
            } catch (Exception e) {
                throw new RuntimeException("JSON serialization failed", e);
            }
        }

        // DateTime: MySQL doesn't accept ISO 8601 with 'T' and 'Z'
        if (value instanceof String str && "mysql".equals(dialect.name())) {
            if (str.matches("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}.*")) {
                return str.replace("T", " ").replace("Z", "").replaceAll("\\.\\d+$", "");
            }
        }

        if (value instanceof Instant instant) {
            if ("mysql".equals(dialect.name())) {
                return DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
                    .format(LocalDateTime.ofInstant(instant, ZoneOffset.UTC));
            }
            return instant.toString();
        }

        return value;
    }
}
