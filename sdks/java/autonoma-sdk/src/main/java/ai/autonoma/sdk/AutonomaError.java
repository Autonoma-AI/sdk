package ai.autonoma.sdk;

public class AutonomaError extends RuntimeException {

    private final String code;
    private final int status;

    public AutonomaError(String message, String code, int status) {
        super(message);
        this.code = code;
        this.status = status;
    }

    public String getCode() { return code; }
    public int getStatus() { return status; }

    public static AutonomaError unknownAction(String action) {
        return new AutonomaError("Unknown action: " + action, "UNKNOWN_ACTION", 400);
    }

    public static AutonomaError invalidSignature() {
        return new AutonomaError("Invalid HMAC signature", "INVALID_SIGNATURE", 401);
    }

    public static AutonomaError invalidRefsToken(String reason) {
        return new AutonomaError("Invalid refs token: " + reason, "INVALID_REFS_TOKEN", 403);
    }

    public static AutonomaError productionBlocked() {
        return new AutonomaError("Environment factory is disabled in production", "PRODUCTION_BLOCKED", 404);
    }

    public static AutonomaError invalidBody(String reason) {
        return new AutonomaError("Invalid request body: " + reason, "INVALID_BODY", 400);
    }

    public static AutonomaError sameSecrets() {
        return new AutonomaError(
            "sharedSecret and signingSecret must be different. The shared secret is known by Autonoma; the signing secret must be private.",
            "SAME_SECRETS", 500
        );
    }
}
