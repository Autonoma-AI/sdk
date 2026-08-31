package ai.autonoma.sdk.types;

/**
 * Context passed to a scenario's {@code up}.
 *
 * @param testRunId unique id for this test run - seed the uniqueness helpers
 *                  ({@code UniqueUtil}) from it so values are unique per run
 *                  yet reproducible between up and down.
 */
public record ScenarioUpContext(String testRunId) {}
