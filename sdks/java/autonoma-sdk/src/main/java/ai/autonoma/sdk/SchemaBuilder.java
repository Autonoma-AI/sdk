package ai.autonoma.sdk;

import ai.autonoma.sdk.types.*;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.lang.reflect.Field;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.*;

/**
 * Build the SDK's wire-shape schema from registered factories.
 *
 * <p>The dashboard's discover response carries a schema block that lists every
 * model the host can create, along with each model's fields. This builder
 * derives that schema from each factory's {@code inputClass} via Java reflection,
 * replacing the SQL introspection that earlier versions relied on.
 */
public final class SchemaBuilder {

    private SchemaBuilder() {}

    /**
     * Build the SDK's discover-time schema from registered factories.
     *
     * @param factories  map of model name to factory definition
     * @param scopeField the scope field name
     * @return a SchemaInfo ready for wire serialization
     */
    public static SchemaInfo buildSchemaFromFactories(Map<String, FactoryDefinition> factories, String scopeField) {
        List<ModelInfo> models = new ArrayList<>();
        for (Map.Entry<String, FactoryDefinition> entry : factories.entrySet()) {
            String entity = entry.getKey();
            FactoryDefinition factory = entry.getValue();
            if (factory.getInputClass() == null) {
                throw new IllegalStateException(
                    "Factory \"" + entity + "\" has no inputClass. " +
                    "Every factory must declare an input class in defineFactory(...).");
            }
            models.add(new ModelInfo(
                entity,
                camelToSnake(entity),
                modelToFields(factory.getInputClass())
            ));
        }
        return new SchemaInfo(models, List.of(), List.of(), scopeField);
    }

    /**
     * Serialize a SchemaInfo to the JSON shape the dashboard expects.
     */
    public static Map<String, Object> schemaToWire(SchemaInfo schema) {
        List<Map<String, Object>> modelsList = new ArrayList<>();
        for (ModelInfo m : schema.models()) {
            List<Map<String, Object>> fieldsList = new ArrayList<>();
            for (FieldInfo f : m.fields()) {
                Map<String, Object> fieldMap = new LinkedHashMap<>();
                fieldMap.put("name", f.name());
                fieldMap.put("type", f.type());
                fieldMap.put("isRequired", f.isRequired());
                fieldMap.put("isId", f.isId());
                fieldMap.put("hasDefault", f.hasDefault());
                fieldsList.add(fieldMap);
            }
            Map<String, Object> modelMap = new LinkedHashMap<>();
            modelMap.put("name", m.name());
            modelMap.put("tableName", m.tableName());
            modelMap.put("fields", fieldsList);
            modelsList.add(modelMap);
        }

        List<Map<String, Object>> edgesList = new ArrayList<>();
        for (FKEdge e : schema.edges()) {
            Map<String, Object> edgeMap = new LinkedHashMap<>();
            edgeMap.put("from", e.from());
            edgeMap.put("to", e.to());
            edgeMap.put("localField", e.localField());
            edgeMap.put("foreignField", e.foreignField());
            edgeMap.put("nullable", e.nullable());
            edgesList.add(edgeMap);
        }

        List<Map<String, Object>> relationsList = new ArrayList<>();
        for (SchemaRelation r : schema.relations()) {
            Map<String, Object> relMap = new LinkedHashMap<>();
            relMap.put("parentModel", r.parentModel());
            relMap.put("childModel", r.childModel());
            relMap.put("parentField", r.parentField());
            relMap.put("childField", r.childField());
            relationsList.add(relMap);
        }

        Map<String, Object> schemaDict = new LinkedHashMap<>();
        schemaDict.put("models", modelsList);
        schemaDict.put("edges", edgesList);
        schemaDict.put("relations", relationsList);
        schemaDict.put("scopeField", schema.scopeField());
        return schemaDict;
    }

    // --- internal helpers ---

    /**
     * Walk a Java class's declared fields to build a list of FieldInfo.
     * Every model gets a synthetic "id" field at the head.
     */
    private static List<FieldInfo> modelToFields(Class<?> inputClass) {
        List<FieldInfo> fields = new ArrayList<>();
        fields.add(new FieldInfo("id", "string", false, true, true));

        for (Field field : inputClass.getDeclaredFields()) {
            // Skip synthetic/static fields
            if (field.isSynthetic() || java.lang.reflect.Modifier.isStatic(field.getModifiers())) {
                continue;
            }

            String fieldName = resolveFieldName(field);
            String fieldType = mapJavaType(field.getType());

            // Check if the field has a default: for records/POJOs, primitive types always have
            // defaults (0, false, etc.). Reference types default to null. We consider a field
            // "has default" if it is not a primitive (i.e., it can be null).
            boolean isPrimitive = field.getType().isPrimitive();
            boolean hasDefault = !isPrimitive;
            boolean isRequired = isPrimitive; // primitives are always required

            // If the type is Optional-like or has @JsonProperty with a default, adjust
            if (Optional.class.isAssignableFrom(field.getType())) {
                hasDefault = true;
                isRequired = false;
            }

            fields.add(new FieldInfo(fieldName, fieldType, isRequired, false, hasDefault));
        }
        return fields;
    }

    /**
     * Resolve the wire name for a field, checking Jackson @JsonProperty first.
     */
    private static String resolveFieldName(Field field) {
        JsonProperty annotation = field.getAnnotation(JsonProperty.class);
        if (annotation != null && !annotation.value().isEmpty()) {
            return annotation.value();
        }
        return field.getName();
    }

    /**
     * Map a Java type to the SDK's coarse type string.
     */
    private static String mapJavaType(Class<?> type) {
        if (type == boolean.class || type == Boolean.class) return "boolean";
        if (type == int.class || type == Integer.class
            || type == long.class || type == Long.class) return "integer";
        if (type == double.class || type == Double.class
            || type == float.class || type == Float.class) return "number";
        if (type == String.class) return "string";
        if (Instant.class.isAssignableFrom(type) || LocalDateTime.class.isAssignableFrom(type)) return "timestamp";
        if (LocalDate.class.isAssignableFrom(type)) return "date";
        if (UUID.class.isAssignableFrom(type)) return "uuid";
        if (type.isArray() || Collection.class.isAssignableFrom(type) || Map.class.isAssignableFrom(type)) return "json";
        if (type == java.math.BigDecimal.class) return "number";
        return "string";
    }

    /**
     * Convert CamelCase to snake_case for cosmetic tableName.
     */
    static String camelToSnake(String name) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < name.length(); i++) {
            char ch = name.charAt(i);
            if (Character.isUpperCase(ch) && i > 0 && !Character.isUpperCase(name.charAt(i - 1))) {
                out.append('_');
            }
            out.append(Character.toLowerCase(ch));
        }
        return out.toString();
    }
}
