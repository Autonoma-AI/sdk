package ai.autonoma.sdk;

import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializerProvider;
import com.fasterxml.jackson.databind.module.SimpleModule;
import com.fasterxml.jackson.databind.ser.std.StdSerializer;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;

/**
 * JWT-like token (header.payload.signature) for signing/verifying created entity refs.
 */
public final class RefsUtil {

    private static final ObjectMapper MAPPER = createMapper();

    private static ObjectMapper createMapper() {
        ObjectMapper mapper = new ObjectMapper();
        SimpleModule module = new SimpleModule();

        // LocalDateTime -> ISO string
        module.addSerializer(LocalDateTime.class, new StdSerializer<LocalDateTime>(LocalDateTime.class) {
            @Override
            public void serialize(LocalDateTime value, JsonGenerator gen, SerializerProvider provider) throws IOException {
                gen.writeString(value.atZone(ZoneOffset.UTC).format(DateTimeFormatter.ISO_INSTANT));
            }
        });

        // Instant -> ISO string
        module.addSerializer(Instant.class, new StdSerializer<Instant>(Instant.class) {
            @Override
            public void serialize(Instant value, JsonGenerator gen, SerializerProvider provider) throws IOException {
                gen.writeString(value.toString());
            }
        });

        // Timestamp -> ISO string
        module.addSerializer(Timestamp.class, new StdSerializer<Timestamp>(Timestamp.class) {
            @Override
            public void serialize(Timestamp value, JsonGenerator gen, SerializerProvider provider) throws IOException {
                gen.writeString(value.toInstant().toString());
            }
        });

        // BigDecimal -> number (not string)
        module.addSerializer(BigDecimal.class, new StdSerializer<BigDecimal>(BigDecimal.class) {
            @Override
            public void serialize(BigDecimal value, JsonGenerator gen, SerializerProvider provider) throws IOException {
                gen.writeNumber(value);
            }
        });

        // UUID -> string
        module.addSerializer(UUID.class, new StdSerializer<UUID>(UUID.class) {
            @Override
            public void serialize(UUID value, JsonGenerator gen, SerializerProvider provider) throws IOException {
                gen.writeString(value.toString());
            }
        });

        mapper.registerModule(module);
        return mapper;
    }

    private RefsUtil() {}

    /**
     * Serialize an object to JSON using the custom mapper that handles
     * DB types (Timestamp, Instant, LocalDateTime, BigDecimal, UUID).
     */
    public static String serializeToJson(Object value) {
        try {
            return MAPPER.writeValueAsString(value);
        } catch (Exception e) {
            throw new RuntimeException("JSON serialization failed", e);
        }
    }

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
     * Verify and decode a teardown token. Returns the payload or throws.
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
