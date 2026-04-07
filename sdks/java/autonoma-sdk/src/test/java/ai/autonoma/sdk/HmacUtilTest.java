package ai.autonoma.sdk;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class HmacUtilTest {

    @Test
    void signBody_producesHexDigest() {
        String result = HmacUtil.signBody("hello", "secret");
        assertNotNull(result);
        assertEquals(64, result.length()); // SHA-256 hex = 64 chars
        assertTrue(result.matches("[0-9a-f]+"));
    }

    @Test
    void verifySignature_validSignature() {
        String body = "{\"action\":\"discover\"}";
        String secret = "test-secret";
        String sig = HmacUtil.signBody(body, secret);
        assertTrue(HmacUtil.verifySignature(body, sig, secret));
    }

    @Test
    void verifySignature_invalidSignature() {
        assertFalse(HmacUtil.verifySignature("body", "wrong", "secret"));
    }

    @Test
    void verifySignature_lengthMismatch() {
        assertFalse(HmacUtil.verifySignature("body", "short", "secret"));
    }
}
