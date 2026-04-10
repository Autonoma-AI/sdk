package ai.autonoma.sdk;

import ai.autonoma.sdk.types.*;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;

/**
 * Core request handler for the Autonoma Environment Factory protocol.
 * Routes discover/up/down actions, verifies HMAC signatures, and manages entity lifecycle.
 */
public final class AutonomaHandler {

    public static final String PROTOCOL_VERSION = loadProtocolVersion();

    private static String loadProtocolVersion() {
        try (InputStream is = AutonomaHandler.class.getResourceAsStream("/autonoma/version.txt")) {
            if (is == null) throw new IllegalStateException("protocol/version.txt not found on classpath");
            return new String(is.readAllBytes(), StandardCharsets.UTF_8).trim();
        } catch (java.io.IOException e) {
            throw new IllegalStateException("Failed to read protocol version", e);
        }
    }

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Map<HandlerConfig, IntrospectionResult> introspectionCache =
        Collections.synchronizedMap(new WeakHashMap<>());

    private AutonomaHandler() {}

    private static IntrospectionResult getIntrospection(HandlerConfig config) {
        return introspectionCache.computeIfAbsent(config, k -> {
            Dialect dialect = Dialect.get(config.getDialect());
            return DatabaseIntrospector.introspect(
                config.getExecutor(),
                dialect,
                config.getScopeField(),
                config.getDbSchema(),
                config.getTableNameMap(),
                config.getExcludeTables()
            );
        });
    }

    private static Map<String, Object> buildSdkMeta(HandlerConfig config) {
        SdkInfo sdk = config.getSdk();
        Map<String, Object> sdkMap = new LinkedHashMap<>();
        sdkMap.put("language", "java");
        sdkMap.put("orm", sdk != null ? sdk.orm() : "unknown");
        sdkMap.put("server", sdk != null ? sdk.server() : "unknown");

        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("version", PROTOCOL_VERSION);
        meta.put("sdk", sdkMap);
        return meta;
    }

    public static HandlerResponse handleRequest(HandlerConfig config, HandlerRequest req) {
        try {
            if (config.getSharedSecret().equals(config.getSigningSecret())) {
                throw AutonomaError.sameSecrets();
            }

            if (!config.isAllowProduction()) {
                String env = System.getenv("JAVA_ENV");
                String springProfile = System.getenv("SPRING_PROFILES_ACTIVE");
                if ("production".equals(env) || "production".equals(springProfile) || "prod".equals(springProfile)) {
                    throw AutonomaError.productionBlocked();
                }
            }

            String signature = req.headers().getOrDefault("x-signature",
                req.headers().getOrDefault("X-Signature", ""));

            if (!HmacUtil.verifySignature(req.body(), signature, config.getSharedSecret())) {
                throw AutonomaError.invalidSignature();
            }

            Map<String, Object> body;
            try {
                body = MAPPER.readValue(req.body(), new TypeReference<>() {});
            } catch (Exception e) {
                throw AutonomaError.invalidBody("invalid JSON");
            }

            String action = (String) body.get("action");
            if (action == null) throw AutonomaError.invalidBody("missing action");

            return switch (action) {
                case "discover" -> handleDiscover(config);
                case "up" -> handleUp(config, body);
                case "down" -> handleDown(config, body);
                default -> throw AutonomaError.unknownAction(action);
            };
        } catch (AutonomaError e) {
            return new HandlerResponse(e.getStatus(), Map.of("error", e.getMessage(), "code", e.getCode()));
        } catch (Exception e) {
            String message = e.getMessage() != null ? e.getMessage() : "Internal error";
            return new HandlerResponse(500, Map.of("error", message, "code", "INTERNAL_ERROR"));
        }
    }

    private static HandlerResponse handleDiscover(HandlerConfig config) {
        IntrospectionResult introspection = getIntrospection(config);
        SchemaInfo schema = introspection.schema();

        Map<String, Object> schemaDict = serializeSchema(schema);

        Map<String, Object> responseBody = new LinkedHashMap<>(buildSdkMeta(config));
        responseBody.put("schema", schemaDict);
        return new HandlerResponse(200, responseBody);
    }

    @SuppressWarnings("unchecked")
    private static HandlerResponse handleUp(HandlerConfig config, Map<String, Object> body) {
        Map<String, Object> createRaw = (Map<String, Object>) body.get("create");
        if (createRaw == null) throw AutonomaError.invalidBody("missing \"create\" in request body");

        // Convert raw create into typed structure
        Map<String, List<Map<String, Object>>> create = new LinkedHashMap<>();
        for (var entry : createRaw.entrySet()) {
            List<Map<String, Object>> nodes = (List<Map<String, Object>>) entry.getValue();
            create.put(entry.getKey(), nodes);
        }

        String testRunId = body.containsKey("testRunId") ? (String) body.get("testRunId") : UUID.randomUUID().toString();
        IntrospectionResult introspection = getIntrospection(config);
        SchemaInfo schema = introspection.schema();
        Dialect dialect = Dialect.get(config.getDialect());

        ResolvedTree tree = TreeResolver.resolveTree(create, schema);
        Map<String, List<Map<String, Object>>> refs = new LinkedHashMap<>();
        Map<String, Object> idMap = new LinkedHashMap<>();

        config.getExecutor().transaction(tx -> {
            int i = 0;
            while (i < tree.ops().size()) {
                CreateOp op = tree.ops().get(i);
                String model = op.model();

                // Collect consecutive ops for same model with same batch flag
                List<CreateOp> batch = new ArrayList<>();
                batch.add(op);
                while (i + 1 < tree.ops().size()
                    && tree.ops().get(i + 1).model().equals(model)
                    && tree.ops().get(i + 1).batch() == op.batch()) {
                    i++;
                    batch.add(tree.ops().get(i));
                }

                // Find model info and dynamic PK field
                ModelInfo modelInfo = schema.models().stream()
                    .filter(m -> m.name().equals(model))
                    .findFirst().orElse(null);
                FieldInfo pkField = modelInfo != null
                    ? modelInfo.fields().stream().filter(FieldInfo::isId).findFirst().orElse(null)
                    : null;
                String pkFieldName = pkField != null ? pkField.name() : "id";

                List<Map<String, Object>> resolvedFields = new ArrayList<>();
                for (CreateOp b : batch) {
                    Map<String, Object> fields = new LinkedHashMap<>(b.fields());

                    // Replace temp IDs with real IDs
                    for (var fe : new ArrayList<>(fields.entrySet())) {
                        if (fe.getValue() instanceof String s && s.startsWith("__temp_")) {
                            Object realId = idMap.get(s);
                            if (realId != null) fields.put(fe.getKey(), realId);
                        }
                    }

                    // Inject scope field if applicable
                    FKEdge scopeEdge = null;
                    for (FKEdge e : schema.edges()) {
                        if (e.from().equals(model)
                            && normalizeField(e.localField()).equals(normalizeField(schema.scopeField()))
                            && !e.from().equals(e.to())) {
                            scopeEdge = e;
                            break;
                        }
                    }
                    if (scopeEdge != null && !fields.containsKey(scopeEdge.localField())) {
                        String scopeVal = detectScopeValue(refs, schema.scopeField());
                        if (scopeVal != null) fields.put(scopeEdge.localField(), scopeVal);
                    }

                    // Auto-populate required DateTime fields without defaults
                    if (modelInfo != null) {
                        for (FieldInfo field : modelInfo.fields()) {
                            if (field.isRequired() && !field.hasDefault() && !field.isId()
                                && !fields.containsKey(field.name())) {
                                if ("DateTime".equals(field.type())) {
                                    fields.put(field.name(), Instant.now());
                                }
                            }
                        }
                    }

                    resolvedFields.add(fields);
                }

                Map<String, Map<String, Object>> spec = Map.of(model, Map.of(
                    "count", resolvedFields.size(),
                    "fields", resolvedFields,
                    "batch", op.batch()
                ));

                Map<String, List<Map<String, Object>>> created = EntityCreator.createEntities(
                    tx, dialect, introspection.tableMap(), introspection.columnMaps(),
                    spec, introspection.enumTypeMaps(), schema.models()
                );
                List<Map<String, Object>> records = created.getOrDefault(model, List.of());

                refs.computeIfAbsent(model, k -> new ArrayList<>()).addAll(records);

                for (int j = 0; j < batch.size(); j++) {
                    if (j < records.size()) {
                        Object recordId = records.get(j).get(pkFieldName);
                        if (recordId != null) {
                            idMap.put(batch.get(j).tempId(), recordId);
                        }
                    }
                }

                i++;
            }

            // Resolve deferred FK updates
            for (DeferredUpdate deferred : tree.deferredUpdates()) {
                Object realTargetId = idMap.get(deferred.targetTempId());
                String refTempId = tree.aliases().get(deferred.refAlias());
                Object realRefId = refTempId != null ? idMap.get(refTempId) : null;

                if (realTargetId == null || realRefId == null) {
                    throw new RuntimeException(
                        "_ref \"" + deferred.refAlias() + "\" could not be resolved. "
                        + "Ensure the referenced node has _alias defined in the scenario."
                    );
                }

                ModelInfo deferredModelInfo = schema.models().stream()
                    .filter(m -> m.name().equals(deferred.model()))
                    .findFirst().orElse(null);
                String deferredPkFieldName = deferredModelInfo != null
                    ? deferredModelInfo.fields().stream().filter(FieldInfo::isId).findFirst().map(FieldInfo::name).orElse("id")
                    : "id";

                EntityCreator.updateEntity(
                    tx, dialect, introspection.tableMap(), introspection.columnMaps(),
                    deferred.model(), String.valueOf(realTargetId), Map.of(deferred.field(), realRefId),
                    introspection.enumTypeMaps(), deferredPkFieldName
                );
            }

            return null;
        });

        String scopeValue = detectScopeValue(refs, schema.scopeField());
        if (scopeValue == null) scopeValue = testRunId;

        Map<String, Object> firstUser = findFirstUser(refs);
        AuthContext authContext = new AuthContext(scopeValue, refs);
        AuthResult authResult = config.getAuth().apply(firstUser, authContext);
        Map<String, Object> auth = serializeAuthResult(authResult);

        String refsToken = RefsUtil.signRefs(
            Map.of("refs", refs, "testRunId", scopeValue, "environment", ""),
            config.getSigningSecret()
        );

        Map<String, Object> responseBody = new LinkedHashMap<>(buildSdkMeta(config));
        responseBody.put("auth", auth);
        responseBody.put("refs", refs);
        responseBody.put("refsToken", refsToken);
        return new HandlerResponse(200, responseBody);
    }

    @SuppressWarnings("unchecked")
    private static HandlerResponse handleDown(HandlerConfig config, Map<String, Object> body) {
        String refsToken = (String) body.get("refsToken");
        if (refsToken == null) throw AutonomaError.invalidBody("missing refsToken");

        Map<String, Object> payload;
        try {
            payload = RefsUtil.verifyRefs(refsToken, config.getSigningSecret());
        } catch (Exception e) {
            throw AutonomaError.invalidRefsToken(e.getMessage());
        }

        IntrospectionResult introspection = getIntrospection(config);
        Dialect dialect = Dialect.get(config.getDialect());

        // Convert refs from payload
        Map<String, List<Map<String, Object>>> refs = null;
        if (payload.containsKey("refs")) {
            refs = (Map<String, List<Map<String, Object>>>) payload.get("refs");
        }

        TeardownExecutor.teardown(
            config.getExecutor(), dialect,
            introspection.tableMap(), introspection.columnMaps(),
            introspection.schema(), (String) payload.get("testRunId"), refs
        );

        Map<String, Object> responseBody = new LinkedHashMap<>(buildSdkMeta(config));
        responseBody.put("ok", true);
        return new HandlerResponse(200, responseBody);
    }

    private static Map<String, Object> findFirstUser(Map<String, List<Map<String, Object>>> refs) {
        for (var entry : refs.entrySet()) {
            String normalized = entry.getKey().toLowerCase();
            if (("user".equals(normalized) || "users".equals(normalized)) && !entry.getValue().isEmpty()) {
                return entry.getValue().get(0);
            }
        }
        return null;
    }

    private static String normalizeField(String name) {
        return name.replace("_", "").toLowerCase();
    }

    private static String detectScopeValue(Map<String, List<Map<String, Object>>> refs, String scopeField) {
        String scopeNormalized = normalizeField(scopeField);
        for (List<Map<String, Object>> records : refs.values()) {
            for (Map<String, Object> record : records) {
                for (var entry : record.entrySet()) {
                    if (normalizeField(entry.getKey()).equals(scopeNormalized) && entry.getValue() instanceof String s) {
                        return s;
                    }
                }
            }
        }
        return null;
    }

    private static Map<String, Object> serializeSchema(SchemaInfo schema) {
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
            modelsList.add(Map.of("name", m.name(), "fields", fieldsList));
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

    private static Map<String, Object> serializeAuthResult(AuthResult result) {
        Map<String, Object> auth = new LinkedHashMap<>();
        if (result.cookies() != null) {
            List<Map<String, Object>> cookiesList = new ArrayList<>();
            for (AuthCookie c : result.cookies()) {
                Map<String, Object> cm = new LinkedHashMap<>();
                cm.put("name", c.name());
                cm.put("value", c.value());
                if (c.httpOnly() != null) cm.put("httpOnly", c.httpOnly());
                if (c.sameSite() != null) cm.put("sameSite", c.sameSite());
                if (c.path() != null) cm.put("path", c.path());
                if (c.domain() != null) cm.put("domain", c.domain());
                if (c.secure() != null) cm.put("secure", c.secure());
                if (c.maxAge() != null) cm.put("maxAge", c.maxAge());
                cookiesList.add(cm);
            }
            auth.put("cookies", cookiesList);
        }
        if (result.headers() != null) auth.put("headers", result.headers());
        if (result.credentials() != null) auth.put("credentials", result.credentials());
        return auth;
    }
}
