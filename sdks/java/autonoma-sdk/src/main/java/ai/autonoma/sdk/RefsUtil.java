package ai.autonoma.sdk;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Map;

/**
 * JWT-like token (header.payload.signature) for signing/verifying created entity refs.
 */
public final class RefsUtil {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private RefsUtil() {}

    /**
     * Sign refs into a JWT-like token (header.payload.signature).
     */
    public static String signRefs(Map<String, Object> payload, String secret) {
        try {
            String header = base64url(Map.of("alg", "HS256", "typ", "REFS"));
            String body = base64url(payload);
            String signature = hmacBase64url(header + "." + body, secret);
            return header + "." + body + "." + signature;
        } catch (Exception e) {
            throw new RuntimeException("Refs signing failed", e);
        }
    }

    /**
     * Verify and decode a refs token. Returns the payload or throws.
     */
    public static Map<String, Object> verifyRefs(String token, String secret) {
        String[] parts = token.split("\\.");
        if (parts.length != 3) throw new RuntimeException("malformed token");

        String header = parts[0];
        String body = parts[1];
        String signature = parts[2];

        String expected = hmacBase64url(header + "." + body, secret);
        if (!MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8), signature.getBytes(StandardCharsets.UTF_8)))
            throw new RuntimeException("signature mismatch");

        try {
            byte[] decoded = Base64.getUrlDecoder().decode(body);
            return MAPPER.readValue(decoded, new TypeReference<>() {});
        } catch (Exception e) {
            throw new RuntimeException("Failed to decode refs payload", e);
        }
    }

    private static String base64url(Object obj) {
        try {
            byte[] json = MAPPER.writeValueAsBytes(obj);
            return Base64.getUrlEncoder().withoutPadding().encodeToString(json);
        } catch (Exception e) {
            throw new RuntimeException("JSON serialization failed", e);
        }
    }

    private static String hmacBase64url(String data, String secret) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] hash = mac.doFinal(data.getBytes(StandardCharsets.UTF_8));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(hash);
        } catch (Exception e) {
            throw new RuntimeException("HMAC signing failed", e);
        }
    }
}
