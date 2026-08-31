package ai.autonoma.sdk.types;

import java.util.Map;

/**
 * What a scenario's {@code up} returns. Every field is optional (may be null).
 *
 * @param auth     credentials the test runner uses to act as the seeded user
 * @param teardown opaque handles carried inside the signed teardown token and
 *                 handed back to {@code down} verbatim, so a scenario can carry
 *                 what it needs to tear itself down (arbitrary JSON object)
 */
public record ScenarioUpResult(
    AuthResult auth,
    Map<String, Object> teardown
) {
    /** An up result that seeds nothing. */
    public static ScenarioUpResult empty() {
        return new ScenarioUpResult(null, null);
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private AuthResult auth;
        private Map<String, Object> teardown;

        public Builder auth(AuthResult auth) { this.auth = auth; return this; }
        public Builder teardown(Map<String, Object> teardown) { this.teardown = teardown; return this; }

        public ScenarioUpResult build() {
            return new ScenarioUpResult(auth, teardown);
        }
    }
}
