package ai.autonoma.sdk;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/**
 * Compute a stable 16-char hex fingerprint of a scenario definition.
 * Uses sha256 of the JSON-serialized spec with sorted keys.
 */
public final class FingerprintUtil {

    private static final ObjectMapper MAPPER = new ObjectMapper()
        .configure(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS, true);

    private FingerprintUtil() {}

    public static String fingerprint(Object value) {
        try {
            Object sorted = sortKeys(value);
            String json = MAPPER.writeValueAsString(sorted);
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(json.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : hash) {
                sb.append(String.format("%02x", b & 0xff));
            }
            return sb.substring(0, 16);
        } catch (Exception e) {
            throw new RuntimeException("Fingerprint computation failed", e);
        }
    }

    @SuppressWarnings("unchecked")
    private static Object sortKeys(Object value) {
        if (value instanceof Map<?, ?> map) {
            TreeMap<String, Object> sorted = new TreeMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                sorted.put(String.valueOf(entry.getKey()), sortKeys(entry.getValue()));
            }
            return sorted;
        }
        if (value instanceof List<?> list) {
            List<Object> result = new ArrayList<>(list.size());
            for (Object item : list) {
                result.add(sortKeys(item));
            }
            return result;
        }
        return value;
    }
}
