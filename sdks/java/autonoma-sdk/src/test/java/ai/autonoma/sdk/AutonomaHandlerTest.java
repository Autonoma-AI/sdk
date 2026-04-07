package ai.autonoma.sdk;

import ai.autonoma.sdk.types.*;
import org.junit.jupiter.api.Test;

import java.util.*;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.*;

class AutonomaHandlerTest {

    @Test
    void handleRequest_invalidSignature() {
        HandlerConfig config = new HandlerConfig(
            dummyExecutor(), "orgId", "shared", "signing"
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
            dummyExecutor(), "orgId", "same", "same"
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
            dummyExecutor(), "orgId", secret, "signing-secret"
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
            dummyExecutor(), "orgId", secret, "signing-secret"
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
            dummyExecutor(), "orgId", secret, "signing-secret"
        );
        HandlerRequest req = new HandlerRequest(body, Map.of("x-signature", sig));
        HandlerResponse resp = AutonomaHandler.handleRequest(config, req);
        assertEquals(400, resp.status());
        assertEquals("INVALID_BODY", resp.body().get("code"));
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
}
