package ai.autonoma.sdk;

import ai.autonoma.sdk.types.*;
import com.fasterxml.jackson.annotation.JsonProperty;
import org.junit.jupiter.api.Test;

import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BiFunction;

import static org.junit.jupiter.api.Assertions.*;

@SuppressWarnings("unused")
class AutonomaHandlerTest {

    // --- Input model classes for tests ---

    public static class OrganizationInput {
        public String name;
    }

    public static class UserInput {
        public String email;
        public String name;
        @JsonProperty("organization_id")
        public String organizationId;
    }

    @Test
    void handleRequest_invalidSignature() {
        HandlerConfig config = new HandlerConfig("orgId", "shared", "signing", dummyAuth());
        config.setFactories(Map.of());
        HandlerRequest req = new HandlerRequest(
            "{\"action\":\"discover\"}",
            Map.of("x-signature", "wrong")
        );
        HandlerResponse resp = AutonomaHandler.handleRequest(config, req);
        assertEquals(401, resp.status());
        assertEquals("INVALID_SIGNATURE", resp.body().get("code"));
    }

    @Test
    void handleRequest_sameSecrets() {
        HandlerConfig config = new HandlerConfig("orgId", "same", "same", dummyAuth());
        HandlerRequest req = new HandlerRequest("{}", Map.of());
        HandlerResponse resp = AutonomaHandler.handleRequest(config, req);
        assertEquals(500, resp.status());
        assertEquals("SAME_SECRETS", resp.body().get("code"));
    }

    @Test
    void handleRequest_validSignature_missingAction() {
        String body = "{}";
        String secret = "shared-secret";
        String sig = HmacUtil.signBody(body, secret);

        HandlerConfig config = new HandlerConfig("orgId", secret, "signing-secret", dummyAuth());
        HandlerRequest req = new HandlerRequest(body, Map.of("x-signature", sig));
        HandlerResponse resp = AutonomaHandler.handleRequest(config, req);
        assertEquals(400, resp.status());
        assertEquals("INVALID_BODY", resp.body().get("code"));
    }

    @Test
    void handleRequest_unknownAction() {
        String body = "{\"action\":\"nope\"}";
        String secret = "shared-secret";
        String sig = HmacUtil.signBody(body, secret);

        HandlerConfig config = new HandlerConfig("orgId", secret, "signing-secret", dummyAuth());
        HandlerRequest req = new HandlerRequest(body, Map.of("x-signature", sig));
        HandlerResponse resp = AutonomaHandler.handleRequest(config, req);
        assertEquals(400, resp.status());
        assertEquals("UNKNOWN_ACTION", resp.body().get("code"));
    }

    @Test
    void handleRequest_invalidJson() {
        String body = "not json";
        String secret = "shared-secret";
        String sig = HmacUtil.signBody(body, secret);

        HandlerConfig config = new HandlerConfig("orgId", secret, "signing-secret", dummyAuth());
        HandlerRequest req = new HandlerRequest(body, Map.of("x-signature", sig));
        HandlerResponse resp = AutonomaHandler.handleRequest(config, req);
        assertEquals(400, resp.status());
        assertEquals("INVALID_BODY", resp.body().get("code"));
    }

    @Test
    void afterUpHookModifiesAuthResult() {
        String secret = "shared-secret";
        String signingSecret = "signing-secret";

        HandlerConfig config = new HandlerConfig("organizationId", secret, signingSecret, dummyAuth());
        config.setFactories(Map.of("Organization", FactoryUtil.defineFactory(
            (data, ctx) -> {
                OrganizationInput input = (OrganizationInput) data;
                Map<String, Object> result = new LinkedHashMap<>();
                result.put("id", "org-1");
                result.put("name", input.name);
                return result;
            },
            OrganizationInput.class
        )));
        config.setAfterUp((hookCtx, authResult) -> {
            assertNotNull(hookCtx.scenarioName());
            assertNotNull(hookCtx.refs());
            return new AuthResult(
                authResult.cookies(),
                authResult.headers(),
                Map.of("extraKey", "extraValue")
            );
        });

        String body = "{\"action\":\"up\",\"create\":{\"Organization\":[{\"name\":\"Org\"}]},\"testRunId\":\"run-123\"}";
        String sig = HmacUtil.signBody(body, secret);

        HandlerRequest req = new HandlerRequest(body, Map.of("x-signature", sig));
        HandlerResponse resp = AutonomaHandler.handleRequest(config, req);

        assertEquals(200, resp.status());
        @SuppressWarnings("unchecked")
        Map<String, Object> auth = (Map<String, Object>) resp.body().get("auth");
        assertNotNull(auth);
        @SuppressWarnings("unchecked")
        Map<String, String> credentials = (Map<String, String>) auth.get("credentials");
        assertNotNull(credentials);
        assertEquals("extraValue", credentials.get("extraKey"));
    }

    @Test
    void beforeDownHookIsCalled() {
        String secret = "shared-secret";
        String signingSecret = "signing-secret";

        AtomicBoolean hookCalled = new AtomicBoolean(false);

        HandlerConfig config = new HandlerConfig("organizationId", secret, signingSecret, dummyAuth());
        config.setFactories(Map.of());
        config.setBeforeDown(hookCtx -> {
            hookCalled.set(true);
            assertEquals("run-123", hookCtx.scenarioName());
            assertNotNull(hookCtx.refs());
        });

        String refsToken = RefsUtil.signRefs(
            Map.of("refs", Map.of("Organization", List.of(Map.of("id", "org-1"))), "testRunId", "run-123", "environment", ""),
            signingSecret
        );

        String body = "{\"action\":\"down\",\"refsToken\":\"" + refsToken + "\"}";
        String sig = HmacUtil.signBody(body, secret);

        HandlerRequest req = new HandlerRequest(body, Map.of("x-signature", sig));
        HandlerResponse resp = AutonomaHandler.handleRequest(config, req);

        assertEquals(200, resp.status());
        assertTrue(hookCalled.get(), "beforeDown hook should have been called");
    }

    // -- Factory tests --

    @Test
    void factoryCreateCalled() {
        String secret = "shared-secret";
        String signingSecret = "signing-secret";
        AtomicBoolean factoryCalled = new AtomicBoolean(false);

        HandlerConfig config = new HandlerConfig("organizationId", secret, signingSecret, dummyAuth());
        config.setFactories(Map.of("Organization", FactoryUtil.defineFactory(
            (data, ctx) -> {
                factoryCalled.set(true);
                OrganizationInput input = (OrganizationInput) data;
                Map<String, Object> result = new LinkedHashMap<>();
                result.put("id", "factory-org-1");
                result.put("name", input.name);
                return result;
            },
            OrganizationInput.class
        )));

        String body = "{\"action\":\"up\",\"create\":{\"Organization\":[{\"name\":\"FactoryOrg\"}]},\"testRunId\":\"run-factory\"}";
        String sig = HmacUtil.signBody(body, secret);
        HandlerRequest req = new HandlerRequest(body, Map.of("x-signature", sig));
        HandlerResponse resp = AutonomaHandler.handleRequest(config, req);

        assertEquals(200, resp.status());
        assertTrue(factoryCalled.get(), "Factory create should have been called");

        @SuppressWarnings("unchecked")
        Map<String, List<Map<String, Object>>> refs = (Map<String, List<Map<String, Object>>>) resp.body().get("refs");
        assertEquals("factory-org-1", refs.get("Organization").get(0).get("id"));
    }

    @Test
    void factoryWithAliasRefResolution() {
        String secret = "shared-secret";
        String signingSecret = "signing-secret";
        AtomicReference<Object> receivedData = new AtomicReference<>();

        HandlerConfig config = new HandlerConfig("organizationId", secret, signingSecret, dummyAuth());
        config.setFactories(Map.of(
            "Organization", FactoryUtil.defineFactory(
                (data, ctx) -> {
                    OrganizationInput input = (OrganizationInput) data;
                    Map<String, Object> r = new LinkedHashMap<>();
                    r.put("id", "resolved-org-id");
                    r.put("name", input.name);
                    return r;
                },
                OrganizationInput.class
            ),
            "User", FactoryUtil.defineFactory(
                (data, ctx) -> {
                    receivedData.set(data);
                    UserInput input = (UserInput) data;
                    Map<String, Object> r = new LinkedHashMap<>();
                    r.put("id", "user-1");
                    r.put("email", input.email);
                    r.put("organization_id", input.organizationId);
                    return r;
                },
                UserInput.class
            )
        ));

        // Use _alias/_ref to wire the FK
        String body = "{\"action\":\"up\",\"create\":{" +
            "\"Organization\":[{\"name\":\"Org\",\"_alias\":\"org1\"}]," +
            "\"User\":[{\"email\":\"a@b.com\",\"name\":\"A\",\"organization_id\":{\"_ref\":\"org1\"}}]" +
            "},\"testRunId\":\"run-fk\"}";
        String sig = HmacUtil.signBody(body, secret);
        HandlerRequest req = new HandlerRequest(body, Map.of("x-signature", sig));
        HandlerResponse resp = AutonomaHandler.handleRequest(config, req);

        assertEquals(200, resp.status());
        assertNotNull(receivedData.get(), "User factory should have been called");
        UserInput userInput = (UserInput) receivedData.get();
        assertEquals("resolved-org-id", userInput.organizationId,
            "Factory should receive the resolved org ID, not a temp ID");
    }

    @Test
    void factoryMissingPKFieldReturnsError() {
        String secret = "shared-secret";
        String signingSecret = "signing-secret";

        HandlerConfig config = new HandlerConfig("organizationId", secret, signingSecret, dummyAuth());
        config.setFactories(Map.of("Organization", FactoryUtil.defineFactory(
            (data, ctx) -> {
                Map<String, Object> r = new LinkedHashMap<>();
                r.put("name", ((OrganizationInput) data).name); // missing "id"
                return r;
            },
            OrganizationInput.class
        )));

        String body = "{\"action\":\"up\",\"create\":{\"Organization\":[{\"name\":\"NoPK\"}]},\"testRunId\":\"run-nopk\"}";
        String sig = HmacUtil.signBody(body, secret);
        HandlerRequest req = new HandlerRequest(body, Map.of("x-signature", sig));
        HandlerResponse resp = AutonomaHandler.handleRequest(config, req);

        assertEquals(500, resp.status());
        assertEquals("FACTORY_MISSING_PK", resp.body().get("code"));
    }

    @Test
    void factoryTeardownCalledPerRecordInReverseOrder() {
        String secret = "shared-secret";
        String signingSecret = "signing-secret";
        List<String> teardownCalls = Collections.synchronizedList(new ArrayList<>());

        HandlerConfig config = new HandlerConfig("organizationId", secret, signingSecret, dummyAuth());
        config.setFactories(Map.of("Organization", FactoryUtil.defineFactory(
            (data, ctx) -> {
                OrganizationInput input = (OrganizationInput) data;
                Map<String, Object> r = new LinkedHashMap<>();
                r.put("id", "org-" + input.name);
                r.put("name", input.name);
                return r;
            },
            OrganizationInput.class,
            (record, ctx) -> {
                @SuppressWarnings("unchecked")
                Map<String, Object> rec = (Map<String, Object>) record;
                teardownCalls.add((String) rec.get("id"));
            }
        )));

        // First create
        String upBody = "{\"action\":\"up\",\"create\":{\"Organization\":[{\"name\":\"A\"},{\"name\":\"B\"}]},\"testRunId\":\"run-teardown\"}";
        String upSig = HmacUtil.signBody(upBody, secret);
        HandlerRequest upReq = new HandlerRequest(upBody, Map.of("x-signature", upSig));
        HandlerResponse upResp = AutonomaHandler.handleRequest(config, upReq);
        assertEquals(200, upResp.status());
        String refsToken = (String) upResp.body().get("refsToken");

        // Then teardown
        String downBody = "{\"action\":\"down\",\"refsToken\":\"" + refsToken + "\"}";
        String downSig = HmacUtil.signBody(downBody, secret);
        HandlerRequest downReq = new HandlerRequest(downBody, Map.of("x-signature", downSig));
        HandlerResponse downResp = AutonomaHandler.handleRequest(config, downReq);

        assertEquals(200, downResp.status());
        assertEquals(2, teardownCalls.size());
        // Reverse order: B first, then A
        assertEquals(List.of("org-B", "org-A"), teardownCalls);
    }

    @Test
    void noFactoryTeardownSkipsModel() {
        String secret = "shared-secret";
        String signingSecret = "signing-secret";

        HandlerConfig config = new HandlerConfig("organizationId", secret, signingSecret, dummyAuth());
        config.setFactories(Map.of("Organization", FactoryUtil.defineFactory(
            (data, ctx) -> {
                OrganizationInput input = (OrganizationInput) data;
                Map<String, Object> r = new LinkedHashMap<>();
                r.put("id", "org-1");
                r.put("name", input.name);
                return r;
            },
            OrganizationInput.class
            // No teardown
        )));

        String upBody = "{\"action\":\"up\",\"create\":{\"Organization\":[{\"name\":\"Org\"}]},\"testRunId\":\"run-no-td\"}";
        String upSig = HmacUtil.signBody(upBody, secret);
        HandlerRequest upReq = new HandlerRequest(upBody, Map.of("x-signature", upSig));
        HandlerResponse upResp = AutonomaHandler.handleRequest(config, upReq);
        assertEquals(200, upResp.status());

        String refsToken = (String) upResp.body().get("refsToken");
        String downBody = "{\"action\":\"down\",\"refsToken\":\"" + refsToken + "\"}";
        String downSig = HmacUtil.signBody(downBody, secret);
        HandlerRequest downReq = new HandlerRequest(downBody, Map.of("x-signature", downSig));
        HandlerResponse downResp = AutonomaHandler.handleRequest(config, downReq);

        assertEquals(200, downResp.status());
        // No teardown and no SQL fallback -- just skipped
    }

    @Test
    void factoryContextContainsRefsOfPreviouslyCreatedModels() {
        String secret = "shared-secret";
        String signingSecret = "signing-secret";
        AtomicReference<FactoryContext> userCtx = new AtomicReference<>();

        HandlerConfig config = new HandlerConfig("organizationId", secret, signingSecret, dummyAuth());
        config.setFactories(Map.of(
            "Organization", FactoryUtil.defineFactory(
                (data, ctx) -> {
                    OrganizationInput input = (OrganizationInput) data;
                    Map<String, Object> r = new LinkedHashMap<>();
                    r.put("id", "org-ctx");
                    r.put("name", input.name);
                    return r;
                },
                OrganizationInput.class
            ),
            "User", FactoryUtil.defineFactory(
                (data, ctx) -> {
                    userCtx.set(ctx);
                    UserInput input = (UserInput) data;
                    Map<String, Object> r = new LinkedHashMap<>();
                    r.put("id", "user-ctx");
                    r.put("email", input.email);
                    r.put("organization_id", input.organizationId);
                    return r;
                },
                UserInput.class
            )
        ));

        // Use _alias/_ref so topo order puts Organization before User
        String body = "{\"action\":\"up\",\"create\":{" +
            "\"Organization\":[{\"name\":\"Org\",\"_alias\":\"org1\"}]," +
            "\"User\":[{\"email\":\"x@y.com\",\"name\":\"X\",\"organization_id\":{\"_ref\":\"org1\"}}]" +
            "},\"testRunId\":\"run-ctx\"}";
        String sig = HmacUtil.signBody(body, secret);
        HandlerRequest req = new HandlerRequest(body, Map.of("x-signature", sig));
        AutonomaHandler.handleRequest(config, req);

        assertNotNull(userCtx.get(), "User factory should have been called with context");
        assertNotNull(userCtx.get().refs().get("Organization"));
        assertEquals(1, userCtx.get().refs().get("Organization").size());
        assertEquals("org-ctx", userCtx.get().refs().get("Organization").get(0).get("id"));
        assertEquals("run-ctx", userCtx.get().testRunId());
    }

    @Test
    void discoverReturnsSchemaFromFactories() {
        String secret = "shared-secret";
        String signingSecret = "signing-secret";

        HandlerConfig config = new HandlerConfig("organizationId", secret, signingSecret, dummyAuth());
        config.setFactories(Map.of(
            "Organization", FactoryUtil.defineFactory(
                (data, ctx) -> Map.of("id", "x"),
                OrganizationInput.class
            )
        ));

        String body = "{\"action\":\"discover\"}";
        String sig = HmacUtil.signBody(body, secret);
        HandlerRequest req = new HandlerRequest(body, Map.of("x-signature", sig));
        HandlerResponse resp = AutonomaHandler.handleRequest(config, req);

        assertEquals(200, resp.status());
        @SuppressWarnings("unchecked")
        Map<String, Object> schema = (Map<String, Object>) resp.body().get("schema");
        assertNotNull(schema);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> models = (List<Map<String, Object>>) schema.get("models");
        assertEquals(1, models.size());
        assertEquals("Organization", models.get(0).get("name"));
        assertEquals("organization", models.get(0).get("tableName"));
    }

    @Test
    void missingFactoryForModelReturnsError() {
        String secret = "shared-secret";
        String signingSecret = "signing-secret";

        HandlerConfig config = new HandlerConfig("organizationId", secret, signingSecret, dummyAuth());
        config.setFactories(Map.of()); // no factories

        String body = "{\"action\":\"up\",\"create\":{\"Organization\":[{\"name\":\"Org\"}]},\"testRunId\":\"run-miss\"}";
        String sig = HmacUtil.signBody(body, secret);
        HandlerRequest req = new HandlerRequest(body, Map.of("x-signature", sig));
        HandlerResponse resp = AutonomaHandler.handleRequest(config, req);

        assertEquals(400, resp.status());
        assertEquals("INVALID_BODY", resp.body().get("code"));
    }

    private BiFunction<Map<String, Object>, AuthContext, AuthResult> dummyAuth() {
        return (user, ctx) -> AuthResult.ofHeaders(Map.of("Authorization", "Bearer test-token"));
    }
}
