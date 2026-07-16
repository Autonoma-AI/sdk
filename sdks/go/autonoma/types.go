package autonoma

import "reflect"

// SchemaInfo is the wire-shape schema emitted in discover responses.
type SchemaInfo struct {
	Models     []ModelInfo      `json:"models"`
	Edges      []FKEdge         `json:"edges"`
	Relations  []SchemaRelation `json:"relations"`
	ScopeField string           `json:"scopeField"`
}

// SchemaRelation is wire-shape only. Always emitted as an empty list in
// factory-driven setups.
type SchemaRelation struct {
	ParentModel string `json:"parentModel"`
	ChildModel  string `json:"childModel"`
	ParentField string `json:"parentField"`
	ChildField  string `json:"childField"`
}

// ModelInfo describes a single model in the discover schema.
type ModelInfo struct {
	Name      string      `json:"name"`
	TableName string      `json:"tableName"`
	Fields    []FieldInfo `json:"fields"`
}

// FieldInfo describes a single field within a model.
type FieldInfo struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	IsRequired bool   `json:"isRequired"`
	IsId       bool   `json:"isId"`
	HasDefault bool   `json:"hasDefault"`
}

// FKEdge is wire-shape only. Always emitted as an empty list in
// factory-driven setups.
type FKEdge struct {
	From         string `json:"from"`
	To           string `json:"to"`
	LocalField   string `json:"localField"`
	ForeignField string `json:"foreignField"`
	Nullable     bool   `json:"nullable"`
}

// SdkInfo carries SDK metadata for wire responses.
type SdkInfo struct {
	Language string `json:"language"`
	Orm      string `json:"orm"`
	Server   string `json:"server"`
}

// HookContext is passed to handler hooks.
type HookContext struct {
	ScenarioName string
	Refs         map[string][]map[string]any
}

// AuthContext is passed to the auth callback alongside the user record.
type AuthContext struct {
	ScopeValue string
	Refs       map[string][]map[string]any
}

// FactoryContext is passed to factory create and teardown functions.
// Factories that need a database connection get it from the host (their
// own GORM, sqlx, pgx, etc.) -- the SDK does not ship one.
type FactoryContext struct {
	Refs         map[string][]map[string]any
	ScenarioName string
	TestRunID    string
}

// FactoryDefinition defines how to create and optionally teardown entities for a model.
//
// InputStruct is required: the SDK validates the resolved field dict through
// json.Unmarshal into a new instance of InputStruct before invoking Create,
// and uses the same struct to build the discover schema.
//
// RefStruct is optional; when provided, the SDK validates the stored record
// through json.Unmarshal into a new instance of RefStruct before invoking Teardown.
type FactoryDefinition struct {
	// Create builds a single entity from a validated input struct and context.
	// The input parameter is a pointer to an instance of InputStruct.
	// Must return a map with at least an "id" key.
	Create func(input interface{}, ctx FactoryContext) (map[string]any, error)

	// InputStruct is the reflect.Type of the struct used for input validation
	// and discover schema generation. Required.
	InputStruct reflect.Type

	// Teardown is an optional per-record cleanup function.
	// If nil, the SDK has no way to remove rows the factory created.
	Teardown func(record interface{}, ctx FactoryContext) error

	// RefStruct is optional. If provided, the SDK validates the stored record
	// through it before calling Teardown.
	RefStruct reflect.Type
}

// FactoryRegistry maps model names to their factory definitions.
type FactoryRegistry map[string]FactoryDefinition

// HandlerConfig is the configuration for the Autonoma request handler.
type HandlerConfig struct {
	ScopeField    string
	SharedSecret  string
	SigningSecret string
	// Deprecated: ignored; the endpoint is always enabled and HMAC signing is
	// the gate. On Autonoma previews (AUTONOMA_PREVIEWKIT set) no guard is
	// needed; gate manually in your handler for your own production deployments.
	AllowProduction bool
	Auth            func(user map[string]any, ctx AuthContext) (map[string]any, error)
	SDK             *SdkInfo
	BeforeDown      func(ctx HookContext) error
	AfterUp         func(ctx HookContext, auth map[string]any) (map[string]any, error)
	Factories       FactoryRegistry
}

// HandlerRequest represents an incoming HTTP request.
type HandlerRequest struct {
	Body    string
	Headers map[string]string
}

// HandlerResponse represents the HTTP response to send back.
type HandlerResponse struct {
	Status int
	Body   map[string]any
}

// CreateOp represents a single create operation produced by the payload topo resolver.
type CreateOp struct {
	Model  string
	Fields map[string]any
	TempID string
}

// ResolvedTree is the output of ResolvePayloadTree.
type ResolvedTree struct {
	Ops               []CreateOp
	Aliases           map[string]string   // alias -> temp id
	AliasOwnerModel   map[string]string   // alias -> model name
	AliasDependencies map[string][]string // alias -> list of dependency aliases
}

// RefsPayload is the payload stored in the refs token.
type RefsPayload struct {
	Refs              map[string][]map[string]any `json:"refs"`
	TestRunID         string                      `json:"testRunId"`
	Environment       string                      `json:"environment"`
	AliasDependencies map[string][]string         `json:"aliasDependencies,omitempty"`
	AliasOwnerModel   map[string]string           `json:"aliasOwnerModel,omitempty"`
	// ModelOrder preserves the creation-time model ordering so that
	// teardown (which runs in reverse) works correctly in Go where
	// map iteration order is not deterministic.
	ModelOrder []string `json:"modelOrder,omitempty"`
}
