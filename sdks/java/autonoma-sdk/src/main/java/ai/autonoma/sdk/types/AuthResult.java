package ai.autonoma.sdk.types;

import java.util.List;
import java.util.Map;

public record AuthResult(
    List<AuthCookie> cookies,
    Map<String, String> headers,
    Map<String, String> credentials
) {
    public static AuthResult ofCookies(List<AuthCookie> cookies) {
        return new AuthResult(cookies, null, null);
    }

    public static AuthResult ofHeaders(Map<String, String> headers) {
        return new AuthResult(null, headers, null);
    }

    public static AuthResult ofCredentials(Map<String, String> credentials) {
        return new AuthResult(null, null, credentials);
    }
}
