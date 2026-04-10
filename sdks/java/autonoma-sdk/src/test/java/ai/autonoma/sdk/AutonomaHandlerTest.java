package ai.autonoma.sdk;

import ai.autonoma.sdk.types.*;
import org.junit.jupiter.api.Test;

import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
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
