package ai.autonoma.sdk.types;

/**
 * A named scenario (Scenario v2).
 *
 * <p>{@link #up} provisions an isolated environment and returns the data a
 * test needs; the optional {@link #down} tears it back down. Register
 * scenarios on {@link HandlerConfig#getScenarios()}. Implement this interface
 * directly, or build one ergonomically with {@code Scenario.define(...)}.
 */
public interface ScenarioDefinition {

    /** Stable identifier the platform calls up/down by. */
    String name();

    /** Human-readable summary shown in discover. */
    String description();

    /** Runs free-form provisioning code and returns the environment. */
    ScenarioUpResult up(ScenarioUpContext ctx) throws Exception;

    /** Optional teardown. The default is a no-op. */
    default void down(ScenarioDownContext ctx) throws Exception {}
}
