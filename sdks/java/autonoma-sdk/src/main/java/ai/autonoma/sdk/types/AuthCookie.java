package ai.autonoma.sdk.types;

public record AuthCookie(
    String name,
    String value,
    Boolean httpOnly,
    String sameSite,
    String path,
    String domain,
    Boolean secure,
    Integer maxAge
) {
    public AuthCookie(String name, String value) {
        this(name, value, null, null, null, null, null, null);
    }
}
