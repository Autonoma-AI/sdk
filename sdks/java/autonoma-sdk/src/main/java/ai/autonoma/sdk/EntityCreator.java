package ai.autonoma.sdk;

import ai.autonoma.sdk.types.FieldInfo;
import ai.autonoma.sdk.types.ModelInfo;
import ai.autonoma.sdk.types.SQLExecutor;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.regex.Pattern;

/**
 * Create entities via raw SQL INSERT.
 *
 * Entities arrive pre-sorted by FK order (handler does topo-sort via TreeResolver).
 * Each model in spec is inserted sequentially; within a model, batch mode
 * uses a single multi-row INSERT while normal mode inserts one row at a time.
 */
public final class EntityCreator {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Pattern MYSQL_DATETIME_RE = Pattern.compile("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}");

    private EntityCreator() {}

    public static Map<String, List<Map<String, Object>>> createEntities(
            SQLExecutor executor,
            Dialect dialect,
            Map<String, String> tableMap,
            Map<String, Map<String, String>> columnMaps,
            Map<String, Map<String, Object>> spec,
            Map<String, Map<String, String>> enumTypeMaps,
            List<ModelInfo> schemaModels) {

        Map<String, List<Map<String, Object>>> results = new LinkedHashMap<>();

        for (var entry : spec.entrySet()) {
            String model = entry.getKey();
            Map<String, Object> entitySpec = entry.getValue();
            String dbTable = tableMap.get(model);
            if (dbTable == null) throw new RuntimeException("Unknown model \"" + model + "\". Not found in database tables.");

            Map<String, String> colMap = columnMaps.getOrDefault(model, Map.of());
            Map<String, String> enumTypeMap = enumTypeMaps != null ? enumTypeMaps.getOrDefault(model, Map.of()) : Map.of();

            // Bug 4: find actual PK field name from schema
            ModelInfo modelInfo = schemaModels != null
                ? schemaModels.stream().filter(m -> m.name().equals(model)).findFirst().orElse(null)
                : null;
            // When multiple isId fields exist (composite PK), prefer the one named "id"
            List<FieldInfo> idFields = modelInfo != null
                ? modelInfo.fields().stream().filter(FieldInfo::isId).toList()
                : List.of();
            FieldInfo pkField = idFields.stream().filter(f -> f.name().equalsIgnoreCase("id")).findFirst()
                .orElse(idFields.isEmpty() ? null : idFields.get(0));
            String pkFieldName = pkField != null ? pkField.name() : "id";
            String pkFieldType = pkField != null ? pkField.type() : "String";

            @SuppressWarnings("unchecked")
            List<Map<String, Object>> fieldsList = (List<Map<String, Object>>) entitySpec.get("fields");
            boolean batch = Boolean.TRUE.equals(entitySpec.get("batch"));

            if (batch && !fieldsList.isEmpty()) {
                results.put(model, insertBatch(executor, dialect, dbTable, colMap, enumTypeMap, fieldsList, pkFieldName, pkFieldType));
            } else {
                List<Map<String, Object>> created = new ArrayList<>();
                for (Map<String, Object> fields : fieldsList) {
                    List<Map<String, Object>> records = insertOne(executor, dialect, dbTable, colMap, enumTypeMap, fields, pkFieldName, pkFieldType);
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
            Map<String, Map<String, String>> enumTypeMaps,
            String pkFieldName) {

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

        String idCol = colMap.getOrDefault(pkFieldName, pkFieldName);
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
            Map<String, Object> fields,
            String pkFieldName,
            String pkFieldType) {

        // Generate client-side UUID when none provided and PK type is String.
        // Int/BigInt PKs use DB auto-increment, so skip UUID generation.
        if (pkFieldName != null && !fields.containsKey(pkFieldName) && "String".equals(pkFieldType)) {
            fields = new LinkedHashMap<>(fields);
            fields.put(pkFieldName, UUID.randomUUID().toString());
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

        String idCol = colMap.getOrDefault(pkFieldName, pkFieldName);
        Object id = fields.get(pkFieldName != null ? pkFieldName : "id");
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
            List<Map<String, Object>> fieldsArr,
            String pkFieldName,
            String pkFieldType) {

        if (fieldsArr.isEmpty()) return List.of();

        // Generate client-side IDs only when PK type is String.
        // Int/BigInt PKs use DB auto-increment.
        if (pkFieldName != null && "String".equals(pkFieldType)) {
            String finalPkFieldName = pkFieldName;
            fieldsArr = fieldsArr.stream().map(fields -> {
                if (!fields.containsKey(finalPkFieldName)) {
                    Map<String, Object> copy = new LinkedHashMap<>(fields);
                    copy.put(finalPkFieldName, UUID.randomUUID().toString());
                    return copy;
                }
                return fields;
            }).toList();
        }

        // Compute union of keys across all rows in deterministic (sorted) order
        Set<String> fieldNameSet = new TreeSet<>();
        for (Map<String, Object> fields : fieldsArr) {
            fieldNameSet.addAll(fields.keySet());
        }
        List<String> fieldNames = new ArrayList<>(fieldNameSet);

        // Fall back to individual inserts when there are no fields
        if (fieldNames.isEmpty()) {
            List<Map<String, Object>> results = new ArrayList<>();
            for (Map<String, Object> fields : fieldsArr) {
                List<Map<String, Object>> records = insertOne(executor, dialect, dbTable, colMap, enumTypeMap, fields, pkFieldName, pkFieldType);
                if (!records.isEmpty()) results.add(records.get(0));
            }
            return results;
        }

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

        // JSON: stringify objects/dicts for JSON/JSONB columns.
        // Arrays are returned as native arrays for Postgres ARRAY columns.
        if (value instanceof List) {
            return value;
        }
        if (value instanceof Map) {
            try {
                return MAPPER.writeValueAsString(value);
            } catch (Exception e) {
                throw new RuntimeException("JSON serialization failed", e);
            }
        }

        // DateTime: MySQL doesn't accept ISO 8601 with 'T' and 'Z'
        if (value instanceof String str && "mysql".equals(dialect.name())) {
            if (MYSQL_DATETIME_RE.matcher(str).find()) {
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
