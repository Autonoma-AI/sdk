package autonoma

// ScenarioUpContext is passed to a scenario's Up.
type ScenarioUpContext struct {
	// TestRunID is the unique id for this test run. Seed the uniqueness helpers
	// (UniqueEmail, UniqueSlug, ...) from it so values are unique per run yet
	// reproducible between Up and Down.
	TestRunID string
}

// ScenarioUpResult is what a scenario's Up returns. Every field is optional.
type ScenarioUpResult struct {
	// Auth is the credentials the test runner uses to act as the seeded user.
	Auth *AuthResult
	// Teardown are opaque handles carried inside the signed teardown token and
	// handed back to Down verbatim, so a scenario can carry what it needs to
	// tear itself down.
	Teardown map[string]any
}

// ScenarioDownContext is passed to a scenario's Down.
type ScenarioDownContext struct {
	// Name is the scenario name, recovered from the verified teardown token.
	Name string
	// Teardown are the handles this scenario returned from Up.
	Teardown map[string]any
	// TestRunID is the testRunId captured at Up time.
	TestRunID string
}

// ScenarioDefinition is a named scenario. Up provisions an isolated environment
// a test needs; the optional Down tears it back down.
// Register scenarios on HandlerConfig.Scenarios.
type ScenarioDefinition struct {
	// Name is the stable identifier the platform calls Up/Down by.
	Name string
	// Description is the human-readable summary shown in discover.
	Description string
	// Up runs free-form provisioning code and returns the environment.
	Up func(ctx ScenarioUpContext) (ScenarioUpResult, error)
	// Down is optional; a nil Down is a no-op teardown.
	Down func(ctx ScenarioDownContext) error
}

// DefineScenario validates a scenario definition and returns it unchanged.
// It panics on misconfiguration, since an invalid scenario is a programming
// error caught at process start, not a runtime condition.
func DefineScenario(def ScenarioDefinition) ScenarioDefinition {
	if def.Name == "" {
		panic(`autonoma: scenario "Name" must be a non-empty string`)
	}
	if def.Up == nil {
		panic(`autonoma: scenario "Up" must be a non-nil function`)
	}
	return def
}
