package ai.autonoma.sdk;

import ai.autonoma.sdk.types.AuthCookie;
import ai.autonoma.sdk.types.AuthResult;
import ai.autonoma.sdk.types.HandlerConfig;
import ai.autonoma.sdk.types.HandlerRequest;
import ai.autonoma.sdk.types.HandlerResponse;
import ai.autonoma.sdk.types.ScenarioDefinition;
import ai.autonoma.sdk.types.ScenarioDownContext;
import ai.autonoma.sdk.types.ScenarioUpContext;
import ai.autonoma.sdk.types.ScenarioUpResult;
import ai.autonoma.sdk.types.SdkInfo;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Request routing for discover / up / down protocol actions (Scenario v2).
 *
 * <p>{@code discover} lists the registered scenarios; {@code up} looks a
 * scenario up by name, runs its free-form {@code up}, validates the returned
 * {@code data} against the wire limits, signs a teardown token carrying the
 * scenario name, and responds; {@code down} recovers the scenario name from the
 * verified token and routes to that scenario's {@code down}. There is no
 * create-graph interpreter and no factory-derived discover schema.
 */
public final class AutonomaHandler {

    public static final String PROTOCOL_VERSION = loadProtocolVersion();

    private static final int DEFAULT_EXPIRES_IN_SECONDS = 3600;

    private static final ObjectMapper MAPPER = new ObjectMapper();

    // One-shot runtime signal for users who never see the deprecation note on
    // the config field.
    private static final AtomicBoolean WARNED_DEPRECATED_ALLOW_PRODUCTION = new AtomicBoolean(false);

    private AutonomaHandler() {}

    private static String loadProtocolVersion() {
        try (InputStream is = AutonomaHandler.class.getResourceAsStream("/autonoma/version.txt")) {
            if (is == null) throw new IllegalStateException("protocol/version.txt not found on classpath");
            return new String(is.readAllBytes(), StandardCharsets.UTF_8).trim();
        } catch (java.io.IOException e) {
            throw new IllegalStateException("Failed to read protocol version", e);
        }
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
            if (config.isAllowProduction() && WARNED_DEPRECATED_ALLOW_PRODUCTION.compareAndSet(false, true)) {
                System.err.println(
                    "[autonoma] allowProduction is deprecated and ignored - the endpoint is always enabled");
            }

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

            Object actionRaw = body.get("action");
            String action = actionRaw instanceof String s ? s : null;
            if (action == null) {
                throw AutonomaError.invalidBody("missing action. expected one of \"discover\", \"up\" or \"down\"");
            }

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
        List<Map<String, Object>> scenarios = new ArrayList<>();
        for (ScenarioDefinition s : config.getScenarios()) {
            Map<String, Object> descriptor = new LinkedHashMap<>();
            descriptor.put("name", s.name());
            descriptor.put("description", s.description());
            scenarios.add(descriptor);
        }

        Map<String, Object> responseBody = buildSdkMeta(config);
        responseBody.put("scenarios", scenarios);
        return new HandlerResponse(200, responseBody);
    }

    // -----------------------------------------------------------------------
    // up
    // -----------------------------------------------------------------------

    private static HandlerResponse handleUp(HandlerConfig config, Map<String, Object> body) throws Exception {
        String name = readScenarioName(body);
        if (name == null) {
            throw AutonomaError.invalidBody("missing \"scenario.name\" in request body");
        }

        ScenarioDefinition scenario = findScenario(config, name);
        if (scenario == null) {
            throw AutonomaError.unknownEnvironment(name);
        }

        Object testRunIdRaw = body.get("testRunId");
        String testRunId = testRunIdRaw instanceof String s && !s.isEmpty() ? s : UUID.randomUUID().toString();

        ScenarioUpResult result = scenario.up(new ScenarioUpContext(testRunId));
        if (result == null) result = ScenarioUpResult.empty();

        Map<String, Object> teardown = result.teardown() != null ? result.teardown() : Map.of();
        Map<String, Object> teardownPayload = new LinkedHashMap<>();
        teardownPayload.put("refs", teardown);
        teardownPayload.put("testRunId", testRunId);
        teardownPayload.put("environment", name);
        String teardownToken = RefsUtil.signRefs(teardownPayload, config.getSigningSecret());

        int expiresInSeconds = config.getExpiresInSeconds() != null
            ? config.getExpiresInSeconds()
            : DEFAULT_EXPIRES_IN_SECONDS;

        Map<String, Object> responseBody = buildSdkMeta(config);
        if (result.auth() != null) responseBody.put("auth", serializeAuthResult(result.auth()));
        responseBody.put("teardownToken", teardownToken);
        responseBody.put("expiresInSeconds", expiresInSeconds);

        return new HandlerResponse(200, responseBody);
    }

    // -----------------------------------------------------------------------
    // down
    // -----------------------------------------------------------------------

    @SuppressWarnings("unchecked")
    private static HandlerResponse handleDown(HandlerConfig config, Map<String, Object> body) throws Exception {
        Object teardownTokenRaw = body.get("teardownToken");
        String teardownToken = teardownTokenRaw instanceof String s ? s : null;
        if (teardownToken == null || teardownToken.isEmpty()) {
            throw AutonomaError.invalidBody("missing teardownToken");
        }

        Map<String, Object> payload;
        try {
            payload = RefsUtil.verifyRefs(teardownToken, config.getSigningSecret());
        } catch (Exception e) {
            throw AutonomaError.invalidTeardownToken(e.getMessage());
        }

        Map<String, Object> teardown = new LinkedHashMap<>();
        Object teardownRaw = payload.get("refs");
        if (teardownRaw instanceof Map<?, ?> teardownMap) {
            teardown = (Map<String, Object>) teardownMap;
        }

        Object testRunIdRaw = payload.get("testRunId");
        String testRunId = testRunIdRaw instanceof String s ? s : "";

        // The verified token is authoritative for routing; any scenario name on
        // the request body is ignored.
        Object env = payload.get("environment");
        String name = env instanceof String s ? s : "";

        if (!name.isEmpty()) {
            ScenarioDefinition scenario = findScenario(config, name);
            if (scenario != null) {
                scenario.down(new ScenarioDownContext(name, teardown, testRunId));
            }
        }

        Map<String, Object> responseBody = buildSdkMeta(config);
        responseBody.put("ok", true);
        return new HandlerResponse(200, responseBody);
    }

    // -----------------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------------

    private static ScenarioDefinition findScenario(HandlerConfig config, String name) {
        for (ScenarioDefinition s : config.getScenarios()) {
            if (s.name().equals(name)) return s;
        }
        return null;
    }

    /** Read {@code body.scenario.name} from an untrusted JSON body. */
    private static String readScenarioName(Map<String, Object> body) {
        Object scenario = body.get("scenario");
        if (!(scenario instanceof Map<?, ?> map)) return null;
        Object nameRaw = map.get("name");
        return nameRaw instanceof String s ? s : null;
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
