package ai.autonoma.sdk;

import ai.autonoma.sdk.types.*;

import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Introspects a database via information_schema to build SchemaInfo.
 * Auto-maps DB names (snake_case) to model names (PascalCase) and field names (camelCase).
 */
public final class DatabaseIntrospector {

    private static final Pattern MYSQL_ENUM_RE = Pattern.compile("^enum\\((.+)\\)$", Pattern.CASE_INSENSITIVE);

    private DatabaseIntrospector() {}

    public static IntrospectionResult introspect(
            SQLExecutor executor,
            Dialect dialect,
            String scopeField,
            String schema,
            Map<String, String> tableNameMap,
            List<String> excludeTables) {

        String dbSchema = schema != null ? schema : ("mysql".equals(dialect.name()) ? null : "public");
        if (dbSchema == null) {
            throw new RuntimeException("MySQL requires a schema (database name). Pass it via config.dbSchema or HandlerConfig.setDbSchema().");
        }
        Set<String> excludeSet = new HashSet<>(excludeTables != null ? excludeTables : List.of("_prisma_migrations"));

        List<Map<String, Object>> tableRows = normalizeKeys(executor.query(dialect.tablesSQL(dbSchema)));
        List<Map<String, Object>> columnRows = normalizeKeys(executor.query(dialect.columnsSQL(dbSchema)));
        List<Map<String, Object>> pkRows = normalizeKeys(executor.query(dialect.primaryKeysSQL(dbSchema)));
        List<Map<String, Object>> fkRows = normalizeKeys(executor.query(dialect.foreignKeysSQL(dbSchema)));
        List<Map<String, Object>> enumRows = normalizeKeys(executor.query(dialect.enumsSQL(dbSchema)));

        // Build enum lookup
        Map<String, List<String>> enumValues = new LinkedHashMap<>();
        for (Map<String, Object> row : enumRows) {
            String enumName = str(row.get("enum_name"));
            if (enumName == null) continue;
            enumValues.computeIfAbsent(enumName, k -> new ArrayList<>()).add(str(row.get("enum_value")));
        }

        // For MySQL, parse inline enums from column_type
        if ("mysql".equals(dialect.name())) {
            for (Map<String, Object> col : columnRows) {
                List<String> parsed = parseMySQLEnum(str(col.get("udt_name")));
                if (parsed != null) {
                    String enumKey = str(col.get("table_name")) + "." + str(col.get("column_name"));
                    enumValues.put(enumKey, parsed);
                }
            }
        }

        // Build PK lookup
        Map<String, Set<String>> pksByTable = new LinkedHashMap<>();
        for (Map<String, Object> row : pkRows) {
            pksByTable.computeIfAbsent(str(row.get("table_name")), k -> new LinkedHashSet<>())
                .add(str(row.get("column_name")));
        }

        // Build table name mapping
        Map<String, String> userMap = tableNameMap != null ? tableNameMap : Map.of();
        Map<String, String> tblMap = new LinkedHashMap<>();
        Map<String, String> reverseTableMap = new LinkedHashMap<>();

        for (var entry : userMap.entrySet()) {
            tblMap.put(entry.getKey(), entry.getValue());
            reverseTableMap.put(entry.getValue(), entry.getKey());
        }

        List<String> dbTables = new ArrayList<>();
        for (Map<String, Object> row : tableRows) {
            String tableName = str(row.get("table_name"));
            if (!excludeSet.contains(tableName)) dbTables.add(tableName);
        }

        for (String dbTable : dbTables) {
            if (reverseTableMap.containsKey(dbTable)) continue;
            String modelName = snakeToPascal(dbTable);
            tblMap.put(modelName, dbTable);
            reverseTableMap.put(dbTable, modelName);
        }

        // Build column maps and model info
        List<ModelInfo> models = new ArrayList<>();
        Map<String, Map<String, String>> columnMaps = new LinkedHashMap<>();
        Map<String, Map<String, String>> enumTypeMaps = new LinkedHashMap<>();

        // Group columns by table
        Map<String, List<Map<String, Object>>> columnsByTable = new LinkedHashMap<>();
        for (Map<String, Object> row : columnRows) {
            columnsByTable.computeIfAbsent(str(row.get("table_name")), k -> new ArrayList<>()).add(row);
        }

        for (var entry : tblMap.entrySet()) {
            String modelName = entry.getKey();
            String dbTable = entry.getValue();
            List<Map<String, Object>> cols = columnsByTable.getOrDefault(dbTable, List.of());
            Set<String> pks = pksByTable.getOrDefault(dbTable, Set.of());
            Map<String, String> colMap = new LinkedHashMap<>();
            List<FieldInfo> fields = new ArrayList<>();

            for (Map<String, Object> col : cols) {
                String colName = str(col.get("column_name"));
                String fieldName = snakeToCamel(colName);
                colMap.put(fieldName, colName);

                List<String> enumVals;
                if ("mysql".equals(dialect.name())) {
                    enumVals = enumValues.get(str(col.get("table_name")) + "." + colName);
                } else {
                    enumVals = enumValues.get(str(col.get("udt_name")));
                }

                String type;
                if (enumVals != null) {
                    type = "enum(" + String.join(",", enumVals) + ")";
                } else {
                    type = mapDataType(str(col.get("data_type")), str(col.get("udt_name")), dialect.name());
                }

                // Track Postgres types needing explicit parameter casting
                if ("postgres".equals(dialect.name())) {
                    String dataType = str(col.get("data_type"));
                    String udtName = str(col.get("udt_name"));
                    if (enumVals != null) {
                        enumTypeMaps.computeIfAbsent(modelName, k -> new LinkedHashMap<>()).put(fieldName, udtName);
                    } else if ("jsonb".equals(dataType) || "jsonb".equals(udtName) || "json".equals(dataType) || "json".equals(udtName)) {
                        String jsonType = ("json".equals(dataType) || "json".equals(udtName)) ? "json" : "jsonb";
                        enumTypeMaps.computeIfAbsent(modelName, k -> new LinkedHashMap<>()).put(fieldName, jsonType);
                    } else if ((dataType != null && dataType.contains("timestamp")) || "timestamptz".equals(udtName) || "timestamp".equals(udtName)) {
                        enumTypeMaps.computeIfAbsent(modelName, k -> new LinkedHashMap<>()).put(fieldName, udtName);
                    }
                }

                fields.add(new FieldInfo(
                    fieldName,
                    type,
                    "NO".equals(str(col.get("is_nullable"))),
                    pks.contains(colName),
                    col.get("column_default") != null
                ));
            }

            columnMaps.put(modelName, colMap);
            models.add(new ModelInfo(modelName, fields));
        }

        // Build FK edges
        List<FKEdge> edges = new ArrayList<>();
        for (Map<String, Object> fk : fkRows) {
            String fromModel = reverseTableMap.get(str(fk.get("from_table")));
            String toModel = reverseTableMap.get(str(fk.get("to_table")));
            if (fromModel == null || toModel == null) continue;

            Map<String, String> fromColMap = columnMaps.getOrDefault(fromModel, Map.of());
            Map<String, String> toColMap = columnMaps.getOrDefault(toModel, Map.of());
            String localField = reverseGet(fromColMap, str(fk.get("from_column")));
            if (localField == null) localField = str(fk.get("from_column"));
            String foreignField = reverseGet(toColMap, str(fk.get("to_column")));
            if (foreignField == null) foreignField = str(fk.get("to_column"));

            edges.add(new FKEdge(fromModel, toModel, localField, foreignField,
                "YES".equals(str(fk.get("is_nullable")))));
        }

        // Build relations
        List<SchemaRelation> relations = new ArrayList<>();
        for (FKEdge edge : edges) {
            String fromDbTable = tblMap.get(edge.from());
            Map<String, String> fromColMap = columnMaps.getOrDefault(edge.from(), Map.of());
            String fkDbCol = fromColMap.getOrDefault(edge.localField(), edge.localField());
            Set<String> fromPks = pksByTable.getOrDefault(fromDbTable, Set.of());
            boolean isOneToOne = fromPks.size() == 1 && fromPks.contains(fkDbCol);

            // Parent-side
            relations.add(new SchemaRelation(
                edge.to(), edge.from(),
                isOneToOne ? lowerFirst(edge.from()) : pluralCamelCase(edge.from()),
                edge.localField()
            ));

            // Child-side
            relations.add(new SchemaRelation(
                edge.from(), edge.to(),
                lowerFirst(edge.to()),
                edge.localField()
            ));
        }

        SchemaInfo schemaInfo = new SchemaInfo(models, edges, relations, scopeField);
        return new IntrospectionResult(schemaInfo, tblMap, columnMaps, enumTypeMaps);
    }

    // --- Name mapping utilities ---

    static String snakeToPascal(String str) {
        StringBuilder sb = new StringBuilder();
        for (String part : str.split("_")) {
            if (!part.isEmpty()) {
                sb.append(Character.toUpperCase(part.charAt(0))).append(part.substring(1));
            }
        }
        return sb.toString();
    }

    static String snakeToCamel(String str) {
        String pascal = snakeToPascal(str);
        if (pascal.isEmpty()) return pascal;
        return Character.toLowerCase(pascal.charAt(0)) + pascal.substring(1);
    }

    private static String lowerFirst(String str) {
        if (str.isEmpty()) return str;
        return Character.toLowerCase(str.charAt(0)) + str.substring(1);
    }

    private static String pluralCamelCase(String modelName) {
        return pluralize(lowerFirst(modelName));
    }

    private static String pluralize(String str) {
        if (str.endsWith("s") || str.endsWith("x") || str.endsWith("z")
            || str.endsWith("ch") || str.endsWith("sh")) {
            return str + "es";
        }
        if (str.endsWith("y") && str.length() > 1 && !isVowel(str.charAt(str.length() - 2))) {
            return str.substring(0, str.length() - 1) + "ies";
        }
        return str + "s";
    }

    private static boolean isVowel(char ch) {
        return "aeiou".indexOf(Character.toLowerCase(ch)) >= 0;
    }

    private static List<String> parseMySQLEnum(String columnType) {
        if (columnType == null) return null;
        Matcher match = MYSQL_ENUM_RE.matcher(columnType);
        if (!match.matches()) return null;
        List<String> values = new ArrayList<>();
        for (String v : match.group(1).split(",")) {
            values.add(v.trim().replaceAll("^'|'$", ""));
        }
        return values;
    }

    private static String mapDataType(String dataType, String udtName, String dialectName) {
        if (dataType == null) return "String";
        String dt = dataType.toLowerCase();

        // MySQL-specific: tinyint(1) is Boolean (udt_name / column_type carries the display width)
        if ("mysql".equals(dialectName) && dt.equals("tinyint") && udtName != null && udtName.startsWith("tinyint(1)"))
            return "Boolean";

        if (dt.equals("integer") || dt.equals("smallint") || dt.equals("bigint") || dt.equals("int") || dt.equals("mediumint") || dt.equals("tinyint"))
            return "Int";
        if (dt.equals("numeric") || dt.equals("real") || dt.equals("double precision") || dt.equals("float") || dt.equals("double") || dt.equals("decimal"))
            return "Float";
        if (dt.equals("boolean"))
            return "Boolean";
        if (dt.equals("text") || dt.equals("character varying") || dt.equals("character") || dt.equals("varchar") || dt.equals("char")
            || dt.equals("mediumtext") || dt.equals("longtext") || dt.equals("tinytext"))
            return "String";
        if (dt.equals("timestamp with time zone") || dt.equals("timestamp without time zone")
            || dt.equals("date") || dt.equals("time") || dt.equals("datetime") || dt.equals("timestamp"))
            return "DateTime";
        if (dt.equals("json") || dt.equals("jsonb"))
            return "Json";
        if (dt.equals("uuid"))
            return "String";
        if (dt.equals("bytea") || dt.equals("blob") || dt.equals("mediumblob") || dt.equals("longblob") || dt.equals("tinyblob") || dt.equals("binary") || dt.equals("varbinary"))
            return "Bytes";
        if (dt.equals("user-defined") && "postgres".equals(dialectName))
            return udtName;
        if (dt.equals("enum") || dt.equals("set"))
            return udtName;

        return dataType;
    }

    private static String str(Object value) {
        return value == null ? null : String.valueOf(value);
    }

    private static String reverseGet(Map<String, String> map, String dbName) {
        for (var entry : map.entrySet()) {
            if (entry.getValue().equals(dbName)) return entry.getKey();
        }
        return null;
    }

    private static List<Map<String, Object>> normalizeKeys(List<Map<String, Object>> rows) {
        List<Map<String, Object>> result = new ArrayList<>(rows.size());
        for (Map<String, Object> row : rows) {
            Map<String, Object> normalized = new LinkedHashMap<>();
            for (var entry : row.entrySet()) {
                normalized.put(entry.getKey().toLowerCase(), entry.getValue());
            }
            result.add(normalized);
        }
        return result;
    }
}
