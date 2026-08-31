package ai.autonoma.sdk;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.regex.Pattern;

/**
 * Deterministic uniqueness helpers seeded from {@code testRunId}.
 *
 * <p>A scenario's {@code data} needs stable keys across runs but unique values
 * per run (unique emails, org slugs, ids). These derive that uniqueness from
 * {@code (testRunId, ...parts)}: the same inputs always produce the same output
 * within a run, so a scenario's up and a later down compute identical values
 * without storing them.
 *
 * <p>The recipe is {@code sha256(testRunId + (" " + part) for each part)},
 * hex-encoded, truncated to the first 12 chars - and MUST match the other
 * language SDKs byte-for-byte for cross-language conformance.
 */
public final class UniqueUtil {

    private static final int TOKEN_LENGTH = 12;
    private static final Pattern SLUG_NON_ALNUM = Pattern.compile("[^a-z0-9]+");
    private static final Pattern SLUG_TRIM_HYPHENS = Pattern.compile("^-+|-+$");

    private UniqueUtil() {}

    /** A short hex token, deterministic per {@code (testRunId, ...parts)}. */
    public static String uniqueToken(String testRunId, String... parts) {
        return digest(testRunId, parts).substring(0, TOKEN_LENGTH);
    }

    /**
     * A unique id like {@code user_1a2b3c4d5e6f}, deterministic per inputs.
     * An empty/null prefix defaults to {@code id}.
     */
    public static String uniqueId(String testRunId, String prefix, String... parts) {
        String p = (prefix == null || prefix.isEmpty()) ? "id" : prefix;
        return p + "_" + uniqueToken(testRunId, prepend(p, parts));
    }

    /**
     * A URL-safe slug like {@code acme-1a2b3c4d5e6f}, deterministic per inputs.
     * An empty/null base defaults to {@code item}.
     */
    public static String uniqueSlug(String testRunId, String base, String... parts) {
        String b = (base == null || base.isEmpty()) ? "item" : base;
        String token = uniqueToken(testRunId, prepend(b, parts));
        String normalized = SLUG_TRIM_HYPHENS.matcher(
            SLUG_NON_ALNUM.matcher(b.toLowerCase()).replaceAll("-")).replaceAll("");
        if (normalized.isEmpty()) normalized = "item";
        return normalized + "-" + token;
    }

    /**
     * A unique email like {@code user+1a2b3c4d5e6f@example.com}, deterministic
     * per inputs. Empty/null local/domain default to {@code user}/{@code example.com}.
     */
    public static String uniqueEmail(String testRunId, String local, String domain) {
        String l = (local == null || local.isEmpty()) ? "user" : local;
        String d = (domain == null || domain.isEmpty()) ? "example.com" : domain;
        return l + "+" + uniqueToken(testRunId, l, d) + "@" + d;
    }

    private static String digest(String testRunId, String[] parts) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            md.update(testRunId.getBytes(StandardCharsets.UTF_8));
            for (String part : parts) {
                md.update((byte) ' ');
                md.update(String.valueOf(part).getBytes(StandardCharsets.UTF_8));
            }
            return toHex(md.digest());
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 not available", e);
        }
    }

    private static String[] prepend(String first, String[] rest) {
        String[] out = new String[rest.length + 1];
        out[0] = first;
        System.arraycopy(rest, 0, out, 1, rest.length);
        return out;
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16));
            sb.append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }
}
