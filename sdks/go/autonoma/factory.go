package autonoma

import "reflect"

// Factories are an optional helper library a scenario's Up/Down may use to
// create and tear down entities through the app's real logic. They are NOT
// wired to the wire protocol in v2 - the platform only calls a scenario's Up
// and Down, and the scenario decides whether to route through factories.

// FactoryContext is passed to factory Create and Teardown functions. Factories
// that need a database connection get it from the host (their own GORM, sqlx,
// pgx, etc.); the SDK does not ship one.
type FactoryContext struct {
	// Refs holds every record created so far, keyed by model name.
	Refs map[string][]map[string]any
	// ScenarioName is the logical scope value or testRunId fallback.
	ScenarioName string
	// TestRunID is the unique id for this test run.
	TestRunID string
}

// FactoryDefinition describes how to create and optionally tear down entities
// for one model.
//
// InputStruct is required: Create receives a pointer to a freshly unmarshaled
// instance of it. RefStruct is optional; when set, Teardown receives a pointer
// to an instance unmarshaled from the stored record instead of the raw map.
type FactoryDefinition struct {
	// Create builds a single entity from a validated input struct and context.
	// The input parameter is a pointer to an instance of InputStruct. It must
	// return a map with at least an "id" key.
	Create func(input interface{}, ctx FactoryContext) (map[string]any, error)

	// InputStruct is the reflect.Type of the struct used for input validation.
	// Required.
	InputStruct reflect.Type

	// Teardown is an optional per-record cleanup function. If nil, the SDK has
	// no way to remove rows the factory created.
	Teardown func(record interface{}, ctx FactoryContext) error

	// RefStruct is optional. When set, the stored record is unmarshaled through
	// it before Teardown is called.
	RefStruct reflect.Type
}

// FactoryRegistry maps model names to their factory definitions.
type FactoryRegistry map[string]FactoryDefinition

// DefineFactory creates a validated FactoryDefinition. It panics when Create or
// InputStruct is missing, since that is a setup-time programming error.
func DefineFactory(
	create func(input interface{}, ctx FactoryContext) (map[string]any, error),
	inputStruct reflect.Type,
	teardown func(record interface{}, ctx FactoryContext) error,
	refStruct reflect.Type,
) FactoryDefinition {
	if create == nil {
		panic("autonoma: factory definition must include a non-nil Create function")
	}
	if inputStruct == nil {
		panic("autonoma: factory must declare InputStruct")
	}
	t := inputStruct
	for t.Kind() == reflect.Ptr {
		t = t.Elem()
	}
	if t.Kind() != reflect.Struct {
		panic("autonoma: factory InputStruct must be a struct type (or pointer to struct)")
	}

	return FactoryDefinition{
		Create:      create,
		InputStruct: inputStruct,
		Teardown:    teardown,
		RefStruct:   refStruct,
	}
}
