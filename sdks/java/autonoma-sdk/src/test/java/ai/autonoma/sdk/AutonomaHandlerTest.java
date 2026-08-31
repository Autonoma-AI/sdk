package ai.autonoma.sdk;

import ai.autonoma.sdk.types.AuthResult;
import ai.autonoma.sdk.types.HandlerConfig;
import ai.autonoma.sdk.types.HandlerRequest;
import ai.autonoma.sdk.types.HandlerResponse;
import ai.autonoma.sdk.types.ScenarioDefinition;
import ai.autonoma.sdk.types.ScenarioUpResult;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class AutonomaHandlerTest {

    private static final String SHARED = "shared";
    private static final String SIGNING = "signing";

    // --- Helpers ---

    private static HandlerRequest signedReq(Map<String, Object> body, String secret) {
        String json = RefsUtil.serializeToJson(body);
        return new HandlerRequest(json, Map.of("x-signature", HmacUtil.signBody(json, secret)));
    }

    private static HandlerRequest signedReqRaw(String body, String secret) {
        return new HandlerRequest(body, Map.of("x-signature", HmacUtil.signBody(body, secret)));
    }

    private static List<ScenarioDefinition> testScenarios(List<String> downCalls) {
        return List.of(
            Scenario.define(
                "standard",
                "A standard seeded environment",
                ctx -> new ScenarioUpResult(
                    AuthResult.ofHeaders(Map.of("Authorization", "Bearer " + ctx.testRunId())),
                    Map.of("userId", "user-" + ctx.testRunId())),
                ctx -> {
                    if (downCalls != null) downCalls.add(ctx.name() + ":" + ctx.testRunId());
                }),
            Scenario.define(
                "empty",
                "Nothing seeded",
                ctx -> ScenarioUpResult.empty())
        );
    }

    private static HandlerConfig baseConfig(List<String> downCalls) {
        return new HandlerConfig(SHARED, SIGNING, testScenarios(downCalls));
    }

    private static Map<String, Object> body(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            m.put((String) kv[i], kv[i + 1]);
        }
        return m;
    }

    // --- Request gate ---

    @Test
    void handleRequest_invalidSignature() {
        HandlerResponse resp = AutonomaHandler.handleRequest(baseConfig(null),
            new HandlerRequest("{\"action\":\"discover\"}", Map.of("x-signature", "invalid")));
        assertEquals(401, resp.status());
        assertEquals("INVALID_SIGNATURE", resp.body().get("code"));
    }

    @Test
    void handleRequest_sameSecrets() {
        HandlerConfig config = new HandlerConfig("same", "same");
        HandlerResponse resp = AutonomaHandler.handleRequest(config,
            new HandlerRequest("{\"action\":\"discover\"}", Map.of("x-signature", "x")));
        assertEquals(500, resp.status());
        assertEquals("SAME_SECRETS", resp.body().get("code"));
    }

    @Test
    void handleRequest_invalidBody() {
        HandlerResponse resp = AutonomaHandler.handleRequest(baseConfig(null), signedReqRaw("not json", SHARED));
        assertEquals(400, resp.status());
        assertEquals("INVALID_BODY", resp.body().get("code"));
    }

    @Test
    void handleRequest_missingAction() {
        HandlerResponse resp = AutonomaHandler.handleRequest(baseConfig(null), signedReq(body(), SHARED));
        assertEquals(400, resp.status());
        assertEquals("INVALID_BODY", resp.body().get("code"));
    }

    @Test
    void handleRequest_unknownAction() {
        HandlerResponse resp = AutonomaHandler.handleRequest(baseConfig(null),
            signedReq(body("action", "nonexistent"), SHARED));
        assertEquals(400, resp.status());
        assertEquals("UNKNOWN_ACTION", resp.body().get("code"));
    }

    // --- discover ---

    @Test
    @SuppressWarnings("unchecked")
    void discover() {
        HandlerResponse resp = AutonomaHandler.handleRequest(baseConfig(null), signedReq(body("action", "discover"), SHARED));
        assertEquals(200, resp.status());
        assertEquals("2.0", resp.body().get("version"));

        assertInstanceOf(List.class, resp.body().get("scenarios"));
        List<Map<String, Object>> scenarios = (List<Map<String, Object>>) resp.body().get("scenarios");
        assertEquals(2, scenarios.size());
        assertEquals("standard", scenarios.get(0).get("name"));
        assertFalse(((String) scenarios.get(0).get("description")).isEmpty());

        // discover must never leak a create/schema shape.
        assertFalse(resp.body().containsKey("schema"));
    }

    // --- up ---

    @Test
    @SuppressWarnings("unchecked")
    void up_returnsEnvelope() {
        Map<String, Object> req = body("action", "up", "scenario", Map.of("name", "standard"), "testRunId", "run-1");
        HandlerResponse resp = AutonomaHandler.handleRequest(baseConfig(null), signedReq(req, SHARED));
        assertEquals(200, resp.status());
        assertEquals("2.0", resp.body().get("version"));

        String token = (String) resp.body().get("teardownToken");
        assertEquals(3, token.split("\\.").length);
        assertEquals(3600, ((Number) resp.body().get("expiresInSeconds")).intValue());

        Map<String, Object> auth = (Map<String, Object>) resp.body().get("auth");
        Map<String, Object> headers = (Map<String, Object>) auth.get("headers");
        assertEquals("Bearer run-1", headers.get("Authorization"));

        // The duplicated plaintext refs and the old refsToken field are gone.
        assertFalse(resp.body().containsKey("refs"));
        assertFalse(resp.body().containsKey("refsToken"));
    }

    @Test
    void up_customExpires() {
        HandlerConfig config = baseConfig(null).setExpiresInSeconds(60);
        Map<String, Object> req = body("action", "up", "scenario", Map.of("name", "empty"), "testRunId", "r");
        HandlerResponse resp = AutonomaHandler.handleRequest(config, signedReq(req, SHARED));
        assertEquals(60, ((Number) resp.body().get("expiresInSeconds")).intValue());
        // The empty scenario returns nothing, so no auth on the envelope.
        assertFalse(resp.body().containsKey("auth"));
    }

    @Test
    void up_unknownEnvironment() {
        Map<String, Object> req = body("action", "up", "scenario", Map.of("name", "does-not-exist"), "testRunId", "r");
        HandlerResponse resp = AutonomaHandler.handleRequest(baseConfig(null), signedReq(req, SHARED));
        assertEquals(400, resp.status());
        assertEquals("UNKNOWN_ENVIRONMENT", resp.body().get("code"));
    }

    @Test
    void up_missingScenarioName() {
        HandlerResponse resp = AutonomaHandler.handleRequest(baseConfig(null),
            signedReq(body("action", "up", "testRunId", "r"), SHARED));
        assertEquals(400, resp.status());
        assertEquals("INVALID_BODY", resp.body().get("code"));
    }

    // --- down ---

    @Test
    void down_validToken() {
        List<String> downCalls = new ArrayList<>();
        HandlerConfig config = baseConfig(downCalls);

        Map<String, Object> upReq = body("action", "up", "scenario", Map.of("name", "standard"), "testRunId", "run-td");
        String token = (String) AutonomaHandler.handleRequest(config, signedReq(upReq, SHARED)).body().get("teardownToken");

        Map<String, Object> downReq = body("action", "down", "teardownToken", token, "testRunId", "run-td");
        HandlerResponse resp = AutonomaHandler.handleRequest(config, signedReq(downReq, SHARED));
        assertEquals(200, resp.status());
        assertEquals(Boolean.TRUE, resp.body().get("ok"));
        assertEquals(List.of("standard:run-td"), downCalls);
    }

    @Test
    void down_routesByTokenEnvironment() {
        List<String> downCalls = new ArrayList<>();
        HandlerConfig config = baseConfig(downCalls);

        Map<String, Object> upReq = body("action", "up", "scenario", Map.of("name", "standard"), "testRunId", "run-tok");
        String token = (String) AutonomaHandler.handleRequest(config, signedReq(upReq, SHARED)).body().get("teardownToken");

        // No scenario.name on the down request - the handler must recover it
        // from the verified token's environment.
        Map<String, Object> downReq = body("action", "down", "teardownToken", token);
        HandlerResponse resp = AutonomaHandler.handleRequest(config, signedReq(downReq, SHARED));
        assertEquals(200, resp.status());
        assertEquals(List.of("standard:run-tok"), downCalls);
    }

    @Test
    void down_invalidTeardownToken() {
        HandlerResponse resp = AutonomaHandler.handleRequest(baseConfig(null),
            signedReq(body("action", "down", "teardownToken", "tampered.token.value"), SHARED));
        assertEquals(403, resp.status());
        assertEquals("INVALID_TEARDOWN_TOKEN", resp.body().get("code"));
    }

    @Test
    void down_missingTeardownToken() {
        HandlerResponse resp = AutonomaHandler.handleRequest(baseConfig(null),
            signedReq(body("action", "down"), SHARED));
        assertEquals(400, resp.status());
        assertEquals("INVALID_BODY", resp.body().get("code"));
    }

    @Test
    void endpointAlwaysEnabled() {
        // allowProduction is a deprecated no-op: discover serves regardless.
        HandlerConfig config = baseConfig(null).setAllowProduction(false);
        HandlerResponse resp = AutonomaHandler.handleRequest(config, signedReq(body("action", "discover"), SHARED));
        assertEquals(200, resp.status());
    }
}
