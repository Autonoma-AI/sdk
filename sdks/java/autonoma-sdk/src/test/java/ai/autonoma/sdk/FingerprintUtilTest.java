package ai.autonoma.sdk;

import org.junit.jupiter.api.Test;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class FingerprintUtilTest {

    @Test
    void fingerprint_isDeterministic() {
        Map<String, Object> value = Map.of("a", 1, "b", "hello");
        String f1 = FingerprintUtil.fingerprint(value);
        String f2 = FingerprintUtil.fingerprint(value);
        assertEquals(f1, f2);
    }

    @Test
    void fingerprint_is16Chars() {
        String f = FingerprintUtil.fingerprint(Map.of("key", "value"));
        assertEquals(16, f.length());
        assertTrue(f.matches("[0-9a-f]+"));
    }

    @Test
    void fingerprint_orderIndependent() {
        // Java Map.of preserves insertion order but TreeMap is used internally
        Map<String, Object> v1 = Map.of("b", 2, "a", 1);
        Map<String, Object> v2 = Map.of("a", 1, "b", 2);
        assertEquals(FingerprintUtil.fingerprint(v1), FingerprintUtil.fingerprint(v2));
    }
}
