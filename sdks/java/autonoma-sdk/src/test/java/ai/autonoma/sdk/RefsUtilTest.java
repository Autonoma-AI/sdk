package ai.autonoma.sdk;

import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class RefsUtilTest {

    @Test
    void signRefs_threeParts() {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("refs", Map.of("userId", "user-1", "email", "test@test.com"));
        payload.put("testRunId", "test-run-123");
        payload.put("environment", "standard");

        String token = RefsUtil.signRefs(payload, "signing-secret");
        assertEquals(3, token.split("\\.").length);
    }

    @Test
    void verifyRefs_roundTrip() {
        Map<String, Object> refs = new LinkedHashMap<>();
        refs.put("userId", "user-1");
        refs.put("nested", Map.of("count", 3));

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("refs", refs);
        payload.put("testRunId", "test-run-123");
        payload.put("environment", "standard");

        String secret = "signing-secret";
        String token = RefsUtil.signRefs(payload, secret);
        Map<String, Object> got = RefsUtil.verifyRefs(token, secret);

        assertEquals("test-run-123", got.get("testRunId"));
        assertEquals("standard", got.get("environment"));

        assertInstanceOf(Map.class, got.get("refs"));
        Map<?, ?> gotRefs = (Map<?, ?>) got.get("refs");
        assertEquals("user-1", gotRefs.get("userId"));

        assertInstanceOf(Map.class, gotRefs.get("nested"));
        Map<?, ?> nested = (Map<?, ?>) gotRefs.get("nested");
        assertEquals(3, ((Number) nested.get("count")).intValue());
    }

    @Test
    void verifyRefs_rejectsWrongSecret() {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("refs", Map.of());
        payload.put("testRunId", "r");
        payload.put("environment", "e");
        String token = RefsUtil.signRefs(payload, "right-secret");
        assertThrows(RuntimeException.class, () -> RefsUtil.verifyRefs(token, "wrong-secret"));
    }

    @Test
    void verifyRefs_rejectsMalformed() {
        assertThrows(RuntimeException.class, () -> RefsUtil.verifyRefs("only-one-part", "signing-secret"));
    }

    @Test
    void verifyRefs_rejectsTampered() {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("refs", Map.of("a", "b"));
        payload.put("testRunId", "r");
        payload.put("environment", "e");
        String token = RefsUtil.signRefs(payload, "signing-secret");
        String[] parts = token.split("\\.");
        String tampered = parts[0] + ".dGFtcGVyZWQ." + parts[2];
        assertThrows(RuntimeException.class, () -> RefsUtil.verifyRefs(tampered, "signing-secret"));
    }
}
