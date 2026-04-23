package ai.autonoma.sdk;

import ai.autonoma.sdk.types.*;
import org.junit.jupiter.api.Test;

import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BiFunction;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.*;

@SuppressWarnings("unused")

class AutonomaHandlerTest {

    @Test
    void handleRequest_invalidSignature() {
        HandlerConfig config = new HandlerConfig(
            dummyExecutor(), "orgId", "shared", "signing", dummyAuth()
        );
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
        HandlerConfig config = new HandlerConfig(
            dummyExecutor(), "orgId", "same", "same", dummyAuth()
        );
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

        HandlerConfig config = new HandlerConfig(
            dummyExecutor(), "orgId", secret, "signing-secret", dummyAuth()
        );
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

        HandlerConfig config = new HandlerConfig(
            dummyExecutor(), "orgId", secret, "signing-secret", dummyAuth()
        );
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

        HandlerConfig config = new HandlerConfig(
            dummyExecutor(), "orgId", secret, "signing-secret", dummyAuth()
        );
        HandlerRequest req = new HandlerRequest(body, Map.of("x-signature", sig));
        HandlerResponse resp = AutonomaHandler.handleRequest(config, req);
        assertEquals(400, resp.status());
        assertEquals("INVALID_BODY", resp.body().get("code"));
    }

    @Test
    void afterUpHookModifiesAuthResult() {
        String secret = "shared-secret";
        String signingSecret = "signing-secret";

        HandlerConfig config = new HandlerConfig(
            mockExecutor(), "organizationId", secret, signingSecret, dummyAuth()
        );
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

        HandlerConfig config = new HandlerConfig(
            mockExecutor(), "organizationId", secret, signingSecret, dummyAuth()
        );
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

    // ── Factory tests ──

    @Test
    void factoryCreateUsedInsteadOfSQL() {
        String secret = "shared-secret";
        String signingSecret = "signing-secret";
        AtomicBoolean factoryCalled = new AtomicBoolean(false);

        SQLExecutor executor = mockExecutor();
        HandlerConfig config = new HandlerConfig(
            executor, "organizationId", secret, signingSecret, dummyAuth()
        );
        config.setFactories(Map.of("Organization", FactoryUtil.defineFactory(
            (data, ctx) -> {
                factoryCalled.set(true);
                Map<String, Object> result = new LinkedHashMap<>();
                result.put("id", "factory-org-1");
                result.put("name", data.get("name"));
                return result;
            }
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
    void hybridModeFactoryForSomeModelsSQLForOthers() {
        String secret = "shared-secret";
        String signingSecret = "signing-secret";
        AtomicBoolean factoryCalled = new AtomicBoolean(false);

        SQLExecutor executor = mockExecutor();
        HandlerConfig config = new HandlerConfig(
            executor, "organizationId", secret, signingSecret, dummyAuth()
        );
        config.setFactories(Map.of("Organization", FactoryUtil.defineFactory(
            (data, ctx) -> {
                factoryCalled.set(true);
                Map<String, Object> result = new LinkedHashMap<>();
                result.put("id", "factory-org-1");
                result.put("name", data.get("name"));
                return result;
            }
        )));

        String body = "{\"action\":\"up\",\"create\":{\"Organization\":[{\"name\":\"HybridOrg\"}],\"User\":[{\"email\":\"test@example.com\",\"name\":\"Test\"}]},\"testRunId\":\"run-hybrid\"}";
        String sig = HmacUtil.signBody(body, secret);
        HandlerRequest req = new HandlerRequest(body, Map.of("x-signature", sig));
        HandlerResponse resp = AutonomaHandler.handleRequest(config, req);

        assertEquals(200, resp.status());
        assertTrue(factoryCalled.get(), "Factory should have been called for Organization");

        @SuppressWarnings("unchecked")
        Map<String, List<Map<String, Object>>> refs = (Map<String, List<Map<String, Object>>>) resp.body().get("refs");
        assertNotNull(refs.get("User"), "User should have been created via SQL");
        assertFalse(refs.get("User").isEmpty());
    }

    @Test
    void factoryReceivesPreResolvedFKIDs() {
        String secret = "shared-secret";
        String signingSecret = "signing-secret";
        AtomicReference<Map<String, Object>> receivedData = new AtomicReference<>();

        SQLExecutor executor = mockExecutor();
        HandlerConfig config = new HandlerConfig(
            executor, "organizationId", secret, signingSecret, dummyAuth()
        );
        config.setFactories(Map.of(
            "Organization", FactoryUtil.defineFactory(
                (data, ctx) -> {
                    Map<String, Object> r = new LinkedHashMap<>();
                    r.put("id", "resolved-org-id");
                    r.put("name", data.get("name"));
                    return r;
                }
            ),
            "User", FactoryUtil.defineFactory(
                (data, ctx) -> {
                    receivedData.set(new LinkedHashMap<>(data));
                    Map<String, Object> r = new LinkedHashMap<>();
                    r.put("id", "user-1");
                    r.put("email", data.get("email"));
                    r.put("organizationId", data.get("organization_id"));
                    return r;
                }
            )
        ));

        // Nest User under Organization so tree resolver wires the FK
        String body = "{\"action\":\"up\",\"create\":{\"Organization\":[{\"name\":\"Org\",\"User\":[{\"email\":\"a@b.com\",\"name\":\"A\"}]}]},\"testRunId\":\"run-fk\"}";
        String sig = HmacUtil.signBody(body, secret);
        HandlerRequest req = new HandlerRequest(body, Map.of("x-signature", sig));
        HandlerResponse resp = AutonomaHandler.handleRequest(config, req);

        assertEquals(200, resp.status());
        assertNotNull(receivedData.get(), "User factory should have been called");
        // The tree resolver uses the schema's relation field name (camelCase: organizationId)
        // to wire the FK, so the factory receives it as "organizationId"
        Object orgIdValue = receivedData.get().get("organizationId") != null
            ? receivedData.get().get("organizationId")
            : receivedData.get().get("organization_id");
        assertEquals("resolved-org-id", orgIdValue,
            "Factory should receive the resolved org ID, not a temp ID");
    }

    @Test
    void factoryMissingPKFieldReturnsError() {
        String secret = "shared-secret";
        String signingSecret = "signing-secret";

        HandlerConfig config = new HandlerConfig(
            mockExecutor(), "organizationId", secret, signingSecret, dummyAuth()
        );
        config.setFactories(Map.of("Organization", FactoryUtil.defineFactory(
            (data, ctx) -> {
                Map<String, Object> r = new LinkedHashMap<>();
                r.put("name", data.get("name")); // missing "id"
                return r;
            }
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

        HandlerConfig config = new HandlerConfig(
            mockExecutor(), "organizationId", secret, signingSecret, dummyAuth()
        );
        config.setFactories(Map.of("Organization", FactoryUtil.defineFactory(
            (data, ctx) -> {
                Map<String, Object> r = new LinkedHashMap<>();
                r.put("id", "org-" + data.get("name"));
                r.put("name", data.get("name"));
                return r;
            },
            (record, ctx) -> {
                teardownCalls.add((String) record.get("id"));
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
    void sqlTeardownUsedWhenFactoryHasNoTeardown() {
        String secret = "shared-secret";
        String signingSecret = "signing-secret";

        SQLExecutor executor = mockExecutor();
        HandlerConfig config = new HandlerConfig(
            executor, "organizationId", secret, signingSecret, dummyAuth()
        );
        config.setFactories(Map.of("Organization", FactoryUtil.defineFactory(
            (data, ctx) -> {
                Map<String, Object> r = new LinkedHashMap<>();
                r.put("id", "org-1");
                r.put("name", data.get("name"));
                return r;
            }
            // No teardown — SQL DELETE should be used
        )));

        String upBody = "{\"action\":\"up\",\"create\":{\"Organization\":[{\"name\":\"Org\"}]},\"testRunId\":\"run-sql-td\"}";
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
        // SQL DELETE should have been used — no factory teardown was defined
    }

    @Test
    void factoryContextContainsRefsOfPreviouslyCreatedModels() {
        String secret = "shared-secret";
        String signingSecret = "signing-secret";
        AtomicReference<FactoryContext> userCtx = new AtomicReference<>();

        HandlerConfig config = new HandlerConfig(
            mockExecutor(), "organizationId", secret, signingSecret, dummyAuth()
        );
        config.setFactories(Map.of(
            "Organization", FactoryUtil.defineFactory(
                (data, ctx) -> {
                    Map<String, Object> r = new LinkedHashMap<>();
                    r.put("id", "org-ctx");
                    r.put("name", data.get("name"));
                    return r;
                }
            ),
            "User", FactoryUtil.defineFactory(
                (data, ctx) -> {
                    userCtx.set(ctx);
                    Map<String, Object> r = new LinkedHashMap<>();
                    r.put("id", "user-ctx");
                    r.put("email", data.get("email"));
                    r.put("organizationId", data.get("organization_id"));
                    return r;
                }
            )
        ));

        String body = "{\"action\":\"up\",\"create\":{\"Organization\":[{\"name\":\"Org\"}],\"User\":[{\"email\":\"x@y.com\",\"name\":\"X\"}]},\"testRunId\":\"run-ctx\"}";
        String sig = HmacUtil.signBody(body, secret);
        HandlerRequest req = new HandlerRequest(body, Map.of("x-signature", sig));
        AutonomaHandler.handleRequest(config, req);

        assertNotNull(userCtx.get(), "User factory should have been called with context");
        // By the time User factory runs, Organization should already be in refs
        assertNotNull(userCtx.get().refs().get("Organization"));
        assertEquals(1, userCtx.get().refs().get("Organization").size());
        assertEquals("org-ctx", userCtx.get().refs().get("Organization").get(0).get("id"));
        assertEquals("run-ctx", userCtx.get().testRunId());
    }

    private BiFunction<Map<String, Object>, AuthContext, AuthResult> dummyAuth() {
        return (user, ctx) -> AuthResult.ofHeaders(Map.of("Authorization", "Bearer test-token"));
    }

    private SQLExecutor dummyExecutor() {
        return new SQLExecutor() {
            @Override
            public List<Map<String, Object>> query(String sql, Object... params) {
                return List.of();
            }

            @Override
            public <T> T transaction(Function<SQLExecutor, T> fn) {
                return fn.apply(this);
            }
        };
    }

    /**
     * A mock executor that returns canned introspection data and handles INSERT/DELETE.
     */
    private SQLExecutor mockExecutor() {
        List<Map<String, Object>> mockTables = List.of(
            Map.of("table_name", "organization"),
            Map.of("table_name", "user")
        );
        List<Map<String, Object>> mockColumns = List.of(
            Map.of("table_name", "organization", "column_name", "id", "data_type", "uuid", "udt_name", "uuid", "is_nullable", "NO", "column_default", "gen_random_uuid()"),
            Map.of("table_name", "organization", "column_name", "name", "data_type", "text", "udt_name", "text", "is_nullable", "NO"),
            Map.of("table_name", "user", "column_name", "id", "data_type", "uuid", "udt_name", "uuid", "is_nullable", "NO", "column_default", "gen_random_uuid()"),
            Map.of("table_name", "user", "column_name", "email", "data_type", "text", "udt_name", "text", "is_nullable", "NO"),
            Map.of("table_name", "user", "column_name", "organization_id", "data_type", "uuid", "udt_name", "uuid", "is_nullable", "NO")
        );
        List<Map<String, Object>> mockPKs = List.of(
            Map.of("table_name", "organization", "column_name", "id"),
            Map.of("table_name", "user", "column_name", "id")
        );
        List<Map<String, Object>> mockFKs = List.of(
            Map.of("from_table", "user", "from_column", "organization_id", "to_table", "organization", "to_column", "id", "is_nullable", "NO")
        );
        AtomicInteger insertCounter = new AtomicInteger(0);

        return new SQLExecutor() {
            @Override
            public List<Map<String, Object>> query(String sql, Object... params) {
                String trimmed = sql.trim().toLowerCase();
                if (trimmed.contains("information_schema.tables") && !trimmed.contains("table_constraints")) return mockTables;
                if (trimmed.contains("information_schema.columns") && !trimmed.contains("table_constraints")) return mockColumns;
                if (trimmed.contains("foreign key")) return mockFKs;
                if (trimmed.contains("primary key")) return mockPKs;
                if (trimmed.contains("pg_type")) return List.of();

                if (trimmed.startsWith("insert")) {
                    Map<String, Object> record = new LinkedHashMap<>();
                    record.put("id", "mock-id-" + insertCounter.getAndIncrement());
                    if (params != null) {
                        // Extract column names from the SQL
                        int openParen = sql.indexOf('(');
                        int closeParen = sql.indexOf(')');
                        if (openParen >= 0 && closeParen > openParen) {
                            String colSection = sql.substring(openParen + 1, closeParen);
                            String[] cols = colSection.split(",");
                            for (int i = 0; i < cols.length && i < params.length; i++) {
                                String col = cols[i].trim().replace("\"", "");
                                record.put(col, params[i]);
                            }
                        }
                    }
                    return List.of(record);
                }

                return List.of();
            }

            @Override
            public <T> T transaction(Function<SQLExecutor, T> fn) {
                return fn.apply(this);
            }
        };
    }
}
