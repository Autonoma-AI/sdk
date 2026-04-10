package autonoma

import "context"

// SQLExecutor abstracts database access. Wrap your *sql.DB or *sql.Tx into this.
type SQLExecutor interface {
	Query(ctx context.Context, sql string, params ...any) ([]map[string]any, error)
	Transaction(ctx context.Context, fn func(tx SQLExecutor) error) error
}

type SchemaInfo struct {
	Models     []ModelInfo      `json:"models"`
	Edges      []FKEdge         `json:"edges"`
	Relations  []SchemaRelation `json:"relations"`
	ScopeField string           `json:"scopeField"`
}

type SchemaRelation struct {
	ParentModel string `json:"parentModel"`
	ChildModel  string `json:"childModel"`
	ParentField string `json:"parentField"`
	ChildField  string `json:"childField"`
}

type ModelInfo struct {
	Name      string      `json:"name"`
	TableName string      `json:"tableName"`
	Fields    []FieldInfo `json:"fields"`
}

type FieldInfo struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	IsRequired bool   `json:"isRequired"`
	IsId       bool   `json:"isId"`
	HasDefault bool   `json:"hasDefault"`
}

type FKEdge struct {
	From         string `json:"from"`
	To           string `json:"to"`
	LocalField   string `json:"localField"`
	ForeignField string `json:"foreignField"`
	Nullable     bool   `json:"nullable"`
}

type ResolvedEntitySpec struct {
	Count  int
	Fields []map[string]any
}

type SdkInfo struct {
	Language string `json:"language"`
	Orm      string `json:"orm"`
	Server   string `json:"server"`
}

type AuthResult struct {
	Token string         `json:"token"`
	Extra map[string]any `json:"-"`
}

type HandlerConfig struct {
	Executor        SQLExecutor
	ScopeField      string
	Dialect         string // "postgres" or "mysql"
	DBSchema        string
	TableNameMap    map[string]string
	ExcludeTables   []string
	SharedSecret    string
	SigningSecret   string
	AllowProduction bool
	Auth            func(user map[string]any) (*AuthResult, error)
	SDK             *SdkInfo
}

type HandlerRequest struct {
	Body    string
	Headers map[string]string
}

type HandlerResponse struct {
	Status int
	Body   map[string]any
}

type IntrospectionResult struct {
	Schema       SchemaInfo
	TableMap     map[string]string            // model name → DB table name
	ColumnMaps   map[string]map[string]string // model name → (field name → DB column name)
	EnumTypeMaps map[string]map[string]string // model name → (field name → enum type name)
}

type RefsPayload struct {
	Refs        map[string][]map[string]any `json:"refs"`
	TestRunID   string                      `json:"testRunId"`
	Environment string                      `json:"environment"`
}
