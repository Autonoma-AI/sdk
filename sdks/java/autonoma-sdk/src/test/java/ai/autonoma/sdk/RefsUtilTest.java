package ai.autonoma.sdk;

import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class RefsUtilTest {

    @Test
    void signAndVerify_roundTrip() {
        Map<String, Object> payload = Map.of(
            "refs", Map.of("User", List.of(Map.of("id", "u1"))),
            "testRunId", "test-123",
            "environment", ""
        );
        String token = RefsUtil.signRefs(payload, "my-secret");
        assertNotNull(token);

        String[] parts = token.split("\\.");
        assertEquals(3, parts.length);

        Map<String, Object> decoded = RefsUtil.verifyRefs(token, "my-secret");
        assertEquals("test-123", decoded.get("testRunId"));
    }

    @Test
    void verifyRefs_invalidSignature() {
        Map<String, Object> payload = Map.of("refs", Map.of(), "testRunId", "t", "environment", "");
        String token = RefsUtil.signRefs(payload, "secret1");
        assertThrows(RuntimeException.class, () -> RefsUtil.verifyRefs(token, "wrong-secret"));
    }

    @Test
    void verifyRefs_malformedToken() {
        assertThrows(RuntimeException.class, () -> RefsUtil.verifyRefs("not.valid", "secret"));
    }
}
