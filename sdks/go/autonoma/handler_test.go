package autonoma

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
)

func TestHandleRequest_InvalidSignature(t *testing.T) {
	config := &HandlerConfig{
		SharedSecret:  "shared",
		SigningSecret: "signing",
	}
	req := HandlerRequest{
		Body:    `{"action":"discover"}`,
		Headers: map[string]string{"x-signature": "invalid"},
	}

	resp := HandleRequest(context.Background(), config, req)
	if resp.Status != 401 {
		t.Errorf("expected 401, got %d", resp.Status)
	}
	if resp.Body["code"] != "INVALID_SIGNATURE" {
		t.Errorf("expected INVALID_SIGNATURE, got %v", resp.Body["code"])
	}
}

func TestHandleRequest_UnknownAction(t *testing.T) {
	config := &HandlerConfig{
		SharedSecret:  "shared",
		SigningSecret: "signing",
	}
	body := `{"action":"nonexistent"}`
	sig := SignBody(body, "shared")
	req := HandlerRequest{
		Body:    body,
		Headers: map[string]string{"x-signature": sig},
	}

	resp := HandleRequest(context.Background(), config, req)
	if resp.Status != 400 {
		t.Errorf("expected 400, got %d", resp.Status)
	}
	if resp.Body["code"] != "UNKNOWN_ACTION" {
		t.Errorf("expected UNKNOWN_ACTION, got %v", resp.Body["code"])
	}
}

func TestHandleRequest_SameSecrets(t *testing.T) {
	config := &HandlerConfig{
		SharedSecret:  "same",
		SigningSecret: "same",
	}
	req := HandlerRequest{
		Body:    `{"action":"discover"}`,
		Headers: map[string]string{"x-signature": "whatever"},
	}

	resp := HandleRequest(context.Background(), config, req)
	if resp.Status != 500 {
		t.Errorf("expected 500, got %d", resp.Status)
	}
	if resp.Body["code"] != "SAME_SECRETS" {
		t.Errorf("expected SAME_SECRETS, got %v", resp.Body["code"])
	}
}

func TestHandleRequest_InvalidBody(t *testing.T) {
	config := &HandlerConfig{
		SharedSecret:  "shared",
		SigningSecret: "signing",
	}
	body := "not json"
	sig := SignBody(body, "shared")
	req := HandlerRequest{
		Body:    body,
		Headers: map[string]string{"x-signature": sig},
	}

	resp := HandleRequest(context.Background(), config, req)
	if resp.Status != 400 {
		t.Errorf("expected 400, got %d", resp.Status)
	}
	if resp.Body["code"] != "INVALID_BODY" {
		t.Errorf("expected INVALID_BODY, got %v", resp.Body["code"])
	}
}

func TestHandleRequest_InvalidRefsToken(t *testing.T) {
	config := &HandlerConfig{
		SharedSecret:  "shared",
		SigningSecret: "signing",
	}
	body := `{"action":"down","refsToken":"tampered.token.value"}`
	sig := SignBody(body, "shared")
	req := HandlerRequest{
		Body:    body,
		Headers: map[string]string{"x-signature": sig},
	}

	resp := HandleRequest(context.Background(), config, req)
	if resp.Status != 403 {
		t.Errorf("expected 403, got %d", resp.Status)
	}
	if resp.Body["code"] != "INVALID_REFS_TOKEN" {
		t.Errorf("expected INVALID_REFS_TOKEN, got %v", resp.Body["code"])
	}
}

func TestSchemaToJSON(t *testing.T) {
	schema := SchemaInfo{
		Models: []ModelInfo{
			{
				Name:      "User",
				TableName: "users",
				Fields: []FieldInfo{
					{Name: "id", Type: "String", IsRequired: true, IsId: true, HasDefault: true},
					{Name: "email", Type: "String", IsRequired: true, IsId: false, HasDefault: false},
				},
			},
		},
		Edges:      []FKEdge{},
		Relations:  []SchemaRelation{},
		ScopeField: "organizationId",
	}

	result := schemaToJSON(schema)
	data, _ := json.Marshal(result)
	if len(data) == 0 {
		t.Error("expected non-empty JSON")
	}

	models, ok := result["models"].([]map[string]any)
	if !ok || len(models) != 1 {
		t.Fatalf("expected 1 model, got %v", result["models"])
	}
	if models[0]["name"] != "User" {
		t.Errorf("expected User, got %v", models[0]["name"])
	}
}

// mockExecutor is a fake SQLExecutor that returns canned introspection data
// and captures INSERT/DELETE queries for testing handler hooks.
type mockExecutor struct {
	mu           sync.Mutex
	insertCount  int
}

func (m *mockExecutor) Query(ctx context.Context, sql string, params ...any) ([]map[string]any, error) {
	trimmed := strings.ToLower(strings.TrimSpace(sql))

	// Introspection: tables
	if strings.Contains(trimmed, "table_name") && strings.Contains(trimmed, "information_schema.tables") {
		return []map[string]any{
			{"table_name": "user"},
		}, nil
	}

	// Introspection: columns
	if strings.Contains(trimmed, "column_name") && strings.Contains(trimmed, "information_schema.columns") {
		return []map[string]any{
			{"table_name": "user", "column_name": "id", "data_type": "uuid", "udt_name": "uuid", "is_nullable": "NO", "column_default": "gen_random_uuid()"},
			{"table_name": "user", "column_name": "email", "data_type": "character varying", "udt_name": "varchar", "is_nullable": "NO", "column_default": ""},
		}, nil
	}

	// Introspection: foreign keys
	if strings.Contains(trimmed, "foreign key") || (strings.Contains(trimmed, "constraint_type") && strings.Contains(trimmed, "foreign")) {
		return []map[string]any{}, nil
	}

	// Introspection: primary keys
	if strings.Contains(trimmed, "primary key") || strings.Contains(trimmed, "constraint_type") {
		return []map[string]any{
			{"table_name": "user", "column_name": "id"},
		}, nil
	}

	// Introspection: enums
	if strings.Contains(trimmed, "pg_type") || strings.Contains(trimmed, "enum") {
		return []map[string]any{}, nil
	}

	// INSERT: return a fake record
	if strings.HasPrefix(trimmed, "insert") {
		m.mu.Lock()
		m.insertCount++
		id := "mock-id"
		m.mu.Unlock()

		record := map[string]any{"id": id, "email": "test@test.com"}
		// Include any params that were provided
		if len(params) > 0 {
			for i, p := range params {
				if s, ok := p.(string); ok && i == 0 {
					record["id"] = s
				}
			}
		}
		return []map[string]any{record}, nil
	}

	// DELETE/UPDATE: return empty
	return []map[string]any{}, nil
}

func (m *mockExecutor) Transaction(ctx context.Context, fn func(tx SQLExecutor) error) error {
	return fn(m)
}

func TestAfterUpHook(t *testing.T) {
	// Clear introspection cache so our mock executor is used
	introspectionCacheMu.Lock()
	introspectionCache = make(map[*HandlerConfig]*IntrospectionResult)
	introspectionCacheMu.Unlock()

	config := &HandlerConfig{
		Executor:     &mockExecutor{},
		ScopeField:   "organizationId",
		SharedSecret: "shared",
		SigningSecret: "signing",
		Dialect:      "postgres",
		AfterUp: func(ctx HookContext, auth map[string]any) (map[string]any, error) {
			auth["X-Custom"] = "enriched"
			return auth, nil
		},
	}

	bodyMap := map[string]any{
		"action":    "up",
		"create":    map[string]any{"User": []any{map[string]any{"email": "test@test.com"}}},
		"testRunId": "run-123",
	}
	bodyBytes, _ := json.Marshal(bodyMap)
	body := string(bodyBytes)
	sig := SignBody(body, "shared")

	req := HandlerRequest{
		Body:    body,
		Headers: map[string]string{"x-signature": sig},
	}

	resp := HandleRequest(context.Background(), config, req)
	if resp.Status != 200 {
		t.Fatalf("expected 200, got %d: %v", resp.Status, resp.Body)
	}

	auth, ok := resp.Body["auth"].(map[string]any)
	if !ok {
		t.Fatalf("expected auth to be a map, got %T", resp.Body["auth"])
	}
	if auth["X-Custom"] != "enriched" {
		t.Errorf("expected X-Custom to be 'enriched', got %v", auth["X-Custom"])
	}
}

func TestBeforeDownHook(t *testing.T) {
	// Clear introspection cache so our mock executor is used
	introspectionCacheMu.Lock()
	introspectionCache = make(map[*HandlerConfig]*IntrospectionResult)
	introspectionCacheMu.Unlock()

	hookCalled := false
	var capturedScenarioName string

	config := &HandlerConfig{
		Executor:     &mockExecutor{},
		ScopeField:   "organizationId",
		SharedSecret: "shared",
		SigningSecret: "signing",
		Dialect:      "postgres",
		BeforeDown: func(ctx HookContext) error {
			hookCalled = true
			capturedScenarioName = ctx.ScenarioName
			return nil
		},
	}

	testRunId := "run-123"
	refsToken, err := SignRefs(RefsPayload{
		Refs:        map[string][]map[string]any{"User": {{"id": "u1"}}},
		TestRunID:   testRunId,
		Environment: "",
	}, "signing")
	if err != nil {
		t.Fatalf("failed to sign refs: %v", err)
	}

	bodyMap := map[string]any{
		"action":    "down",
		"refsToken": refsToken,
	}
	bodyBytes, _ := json.Marshal(bodyMap)
	body := string(bodyBytes)
	sig := SignBody(body, "shared")

	req := HandlerRequest{
		Body:    body,
		Headers: map[string]string{"x-signature": sig},
	}

	resp := HandleRequest(context.Background(), config, req)
	if resp.Status != 200 {
		t.Fatalf("expected 200, got %d: %v", resp.Status, resp.Body)
	}

	if !hookCalled {
		t.Error("expected BeforeDown hook to be called")
	}
	if capturedScenarioName != testRunId {
		t.Errorf("expected ScenarioName to be %q, got %q", testRunId, capturedScenarioName)
	}
}
