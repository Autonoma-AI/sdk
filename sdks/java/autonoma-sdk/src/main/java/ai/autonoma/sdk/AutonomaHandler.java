package ai.autonoma.sdk;

import ai.autonoma.sdk.types.*;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Core request handler for the Autonoma Environment Factory protocol.
 *
 * <p>Factory-driven design: every model in {@code body.create} must have a
 * registered factory. The SDK uses the factory's {@code inputClass} both to
 * validate inputs and to build the discover schema. Ordering for up and down
 * comes from the create payload's {@code _alias}/{@code _ref} graph; there is
 * no SQL introspection.
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

    private AutonomaHandler() {}

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
            if (action == null) throw AutonomaError.invalidBody("missing action. expected one of 'discover', 'up' or 'down'");

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

    // -----------------------------------------------------------------------
    // discover
    // -----------------------------------------------------------------------

    private static HandlerResponse handleDiscover(HandlerConfig config) {
        Map<String, FactoryDefinition> factories = config.getFactories();
        if (factories == null) factories = Map.of();
        SchemaInfo schema = SchemaBuilder.buildSchemaFromFactories(factories, config.getScopeField());
        Map<String, Object> responseBody = new LinkedHashMap<>(buildSdkMeta(config));
        responseBody.put("schema", SchemaBuilder.schemaToWire(schema));
        return new HandlerResponse(200, responseBody);
    }

    // -----------------------------------------------------------------------
    // up
    // -----------------------------------------------------------------------

    @SuppressWarnings("unchecked")
    private static HandlerResponse handleUp(HandlerConfig config, Map<String, Object> body) {
        Map<String, Object> create = (Map<String, Object>) body.get("create");
        if (create == null) throw AutonomaError.invalidBody("missing \"create\" in request body");

        String testRunId = body.containsKey("testRunId") ? (String) body.get("testRunId") : UUID.randomUUID().toString();

        Map<String, FactoryDefinition> factories = config.getFactories();
        if (factories == null || factories.isEmpty()) {
            throw AutonomaError.invalidBody(
                "no factories registered -- every model in `create` must have a factory.");
        }

        ResolvedTree tree = PayloadTopo.resolvePayloadTree(create);

        Map<String, List<Map<String, Object>>> refs = new LinkedHashMap<>();
        Map<String, Object> idMap = new LinkedHashMap<>();
        Map<String, Integer> modelIndex = new LinkedHashMap<>();

        for (CreateOp op : tree.ops()) {
            String model = op.model();
            FactoryDefinition factory = factories.get(model);
            if (factory == null) {
                throw AutonomaError.invalidBody(
                    "no factory registered for model \"" + model + "\". " +
                    "Register one with defineFactory(...) and add it to HandlerConfig.factories.");
            }

            int idx = modelIndex.getOrDefault(model, 0);
            modelIndex.put(model, idx + 1);

            // Substitute built-in tokens then swap temp ids for real ids.
            Map<String, Object> resolved = (Map<String, Object>) resolveTokens(
                new LinkedHashMap<>(op.fields()), testRunId, idx);
            resolved = swapTempIds(resolved, idMap);

            // Validate through the factory's inputClass and call create.
            Object callInput;
            try {
                callInput = MAPPER.convertValue(resolved, factory.getInputClass());
            } catch (Exception e) {
                throw AutonomaError.invalidBody(
                    "Validation failed for model \"" + model + "\": " + e.getMessage());
            }

            FactoryContext ctx = new FactoryContext(refs, testRunId, testRunId);
            Map<String, Object> record;
            try {
                record = factory.getCreate().create(callInput, ctx);
            } catch (AutonomaError ae) {
                throw ae;
            } catch (Exception e) {
                throw new RuntimeException(e);
            }

            if (record == null || record.get("id") == null) {
                throw new AutonomaError(
                    "Factory for \"" + model + "\" must return a record dict with \"id\"",
                    "FACTORY_MISSING_PK", 500);
            }

            refs.computeIfAbsent(model, k -> new ArrayList<>()).add(record);
            idMap.put(op.tempId(), record.get("id"));
        }

        // Auth callback gets the first User (case-insensitive).
        Map<String, Object> firstUser = findFirstUser(refs);
        String scopeValue = detectScopeValue(refs, config.getScopeField());
        if (scopeValue == null) scopeValue = testRunId;

        AuthContext authContext = new AuthContext(scopeValue, refs);
        AuthResult authResult = config.getAuth().apply(firstUser, authContext);

        if (config.getAfterUp() != null) {
            HookContext hookCtx = new HookContext(scopeValue, refs);
            authResult = config.getAfterUp().apply(hookCtx, authResult);
        }

        Map<String, Object> auth = serializeAuthResult(authResult);

        // Sign refs token with alias dependency info for ordered teardown.
        Map<String, Object> refsPayload = new LinkedHashMap<>();
        refsPayload.put("refs", refs);
        refsPayload.put("testRunId", scopeValue);
        refsPayload.put("environment", "");
        refsPayload.put("aliasDependencies", tree.aliasDependencies());
        refsPayload.put("aliasOwnerModel", tree.aliasOwnerModel());

        String refsToken = RefsUtil.signRefs(refsPayload, config.getSigningSecret());

        Map<String, Object> responseBody = new LinkedHashMap<>(buildSdkMeta(config));
        responseBody.put("auth", auth);
        responseBody.put("refs", refs);
        responseBody.put("refsToken", refsToken);
        return new HandlerResponse(200, responseBody);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> swapTempIds(Map<String, Object> fields, Map<String, Object> idMap) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (Map.Entry<String, Object> entry : fields.entrySet()) {
            result.put(entry.getKey(), swapTempIdValue(entry.getValue(), idMap));
        }
        return result;
    }

    @SuppressWarnings("unchecked")
    private static Object swapTempIdValue(Object value, Map<String, Object> idMap) {
        if (value instanceof String s && s.startsWith("__temp_")) {
            Object real = idMap.get(s);
            return real != null ? real : value;
        }
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> result = new LinkedHashMap<>();
            for (Map.Entry<?, ?> e : map.entrySet()) {
                result.put((String) e.getKey(), swapTempIdValue(e.getValue(), idMap));
            }
            return result;
        }
        if (value instanceof List<?> list) {
            List<Object> result = new ArrayList<>(list.size());
            for (Object v : list) result.add(swapTempIdValue(v, idMap));
            return result;
        }
        return value;
    }

    // -----------------------------------------------------------------------
    // down
    // -----------------------------------------------------------------------

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

        Map<String, List<Map<String, Object>>> refs = new LinkedHashMap<>();
        Object refsRaw = payload.get("refs");
        if (refsRaw instanceof Map<?, ?> refsMap) {
            for (Map.Entry<?, ?> entry : refsMap.entrySet()) {
                String model = (String) entry.getKey();
                List<Map<String, Object>> records = (List<Map<String, Object>>) entry.getValue();
                refs.put(model, records);
            }
        }

        String testRunId = (String) payload.getOrDefault("testRunId", "");
        Map<String, Object> aliasDeps = (Map<String, Object>) payload.get("aliasDependencies");
        Map<String, Object> aliasOwnerModel = (Map<String, Object>) payload.get("aliasOwnerModel");

        if (config.getBeforeDown() != null) {
            HookContext hookCtx = new HookContext(testRunId, refs);
            config.getBeforeDown().accept(hookCtx);
        }

        Map<String, FactoryDefinition> factories = config.getFactories();
        if (factories == null) factories = Map.of();

        List<String> teardownOrder = PayloadTopo.computeTeardownOrder(refs, aliasDeps, aliasOwnerModel);

        for (String model : teardownOrder) {
            FactoryDefinition factory = factories.get(model);
            if (factory == null || factory.getTeardown() == null) {
                continue;
            }
            List<Map<String, Object>> records = refs.getOrDefault(model, List.of());
            FactoryContext ctx = new FactoryContext(refs, testRunId, testRunId);

            List<Map<String, Object>> reversedRecords = new ArrayList<>(records);
            Collections.reverse(reversedRecords);

            for (Map<String, Object> record : reversedRecords) {
                Object tdInput;
                if (factory.getRefClass() != null) {
                    try {
                        tdInput = MAPPER.convertValue(record, factory.getRefClass());
                    } catch (Exception e) {
                        tdInput = record;
                    }
                } else {
                    tdInput = record;
                }
                try {
                    factory.getTeardown().teardown(tdInput, ctx);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            }
        }

        Map<String, Object> responseBody = new LinkedHashMap<>(buildSdkMeta(config));
        responseBody.put("ok", true);
        return new HandlerResponse(200, responseBody);
    }

    // -----------------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------------

    private static final Pattern TOKEN_RE = Pattern.compile("\\{\\{\\s*([^{}]+?)\\s*\\}\\}");
    private static final Pattern CYCLE_RE = Pattern.compile("^cycle\\((.*)\\)$");

    /**
     * Substitute built-in tokens in field values: {{testRunId}}, {{index}},
     * {{cycle(a,b,c)}}. Throws AutonomaError with code UNRESOLVED_TOKEN for any
     * other {{token}} that reaches the SDK.
     */
    @SuppressWarnings("unchecked")
    public static Object resolveTokens(Object value, String testRunId, int index) {
        if (value instanceof String s) {
            Matcher m = TOKEN_RE.matcher(s);
            StringBuilder sb = new StringBuilder();
            while (m.find()) {
                String token = m.group(1).trim();
                String replacement;
                if (token.equals("testRunId")) {
                    replacement = testRunId;
                } else if (token.equals("index")) {
                    replacement = Integer.toString(index);
                } else {
                    Matcher cm = CYCLE_RE.matcher(token);
                    if (cm.matches()) {
                        String[] rawParts = cm.group(1).split(",", -1);
                        List<String> parts = new ArrayList<>();
                        for (String p : rawParts) {
                            String t = p.trim();
                            if (t.length() >= 2
                                && ((t.charAt(0) == '\'' && t.charAt(t.length() - 1) == '\'')
                                 || (t.charAt(0) == '"' && t.charAt(t.length() - 1) == '"'))) {
                                t = t.substring(1, t.length() - 1);
                            }
                            parts.add(t);
                        }
                        replacement = parts.isEmpty() ? "" : parts.get(Math.floorMod(index, parts.size()));
                    } else {
                        throw new AutonomaError(
                            "Unresolved token: {{" + token + "}}",
                            "UNRESOLVED_TOKEN", 400
                        );
                    }
                }
                m.appendReplacement(sb, Matcher.quoteReplacement(replacement));
            }
            m.appendTail(sb);
            return sb.toString();
        }
        if (value instanceof List<?> list) {
            List<Object> out = new ArrayList<>(list.size());
            for (Object v : list) {
                out.add(resolveTokens(v, testRunId, index));
            }
            return out;
        }
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> out = new LinkedHashMap<>();
            for (Map.Entry<?, ?> e : map.entrySet()) {
                out.put((String) e.getKey(), resolveTokens(e.getValue(), testRunId, index));
            }
            return out;
        }
        return value;
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
