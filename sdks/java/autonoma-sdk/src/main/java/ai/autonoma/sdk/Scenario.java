package ai.autonoma.sdk;

import ai.autonoma.sdk.types.ScenarioDefinition;
import ai.autonoma.sdk.types.ScenarioDownContext;
import ai.autonoma.sdk.types.ScenarioUpContext;
import ai.autonoma.sdk.types.ScenarioUpResult;

/**
 * Builds a {@link ScenarioDefinition} from lambdas.
 *
 * <p>A scenario's {@code up} is free-form code (loops, conditionals, real API
 * calls) that provisions an isolated environment and returns the
 * {@code auth}/{@code teardown} a test run needs. An omitted {@code down} is a
 * no-op. Register scenarios with
 * {@code new HandlerConfig(shared, signing, List.of(Scenario.define(...)))}.
 *
 * <pre>{@code
 * Scenario.define(
 *     "single-user",
 *     "One verified user in a fresh org",
 *     ctx -> new ScenarioUpResult(
 *         AuthResult.ofHeaders(Map.of("Authorization", "Bearer " + mintToken(ctx.testRunId()))),
 *         Map.of("userId", userId)),
 *     ctx -> deleteUser((String) ctx.teardown().get("userId")));
 * }</pre>
 */
public final class Scenario {

    private Scenario() {}

    /** Free-form provisioning function. */
    @FunctionalInterface
    public interface UpFn {
        ScenarioUpResult up(ScenarioUpContext ctx) throws Exception;
    }

    /** Optional teardown function. */
    @FunctionalInterface
    public interface DownFn {
        void down(ScenarioDownContext ctx) throws Exception;
    }

    /** Define a scenario with no teardown. */
    public static ScenarioDefinition define(String name, String description, UpFn up) {
        return define(name, description, up, null);
    }

    /** Define a scenario with a teardown. A null {@code down} is a no-op. */
    public static ScenarioDefinition define(String name, String description, UpFn up, DownFn down) {
        if (name == null || name.isEmpty()) {
            throw new IllegalArgumentException("Scenario \"name\" must be a non-empty string");
        }
        if (description == null) {
            throw new IllegalArgumentException("Scenario \"description\" must be a string");
        }
        if (up == null) {
            throw new IllegalArgumentException("Scenario \"up\" must be a function");
        }
        return new ScenarioDefinition() {
            @Override
            public String name() { return name; }

            @Override
            public String description() { return description; }

            @Override
            public ScenarioUpResult up(ScenarioUpContext ctx) throws Exception {
                return up.up(ctx);
            }

            @Override
            public void down(ScenarioDownContext ctx) throws Exception {
                if (down != null) down.down(ctx);
            }
        };
    }
}
