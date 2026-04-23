package autonoma

import (
	"context"
	"encoding/json"
	"fmt"
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

// factoryMockExecutor is a more capable mock that returns an Organization+User schema
// with a foreign key, and tracks INSERT/DELETE queries.
type factoryMockExecutor struct {
	mu           sync.Mutex
	queries      []string
	insertCount  int
}

func (m *factoryMockExecutor) Query(ctx context.Context, sql string, params ...any) ([]map[string]any, error) {
	m.mu.Lock()
	m.queries = append(m.queries, sql)
	m.mu.Unlock()

	trimmed := strings.ToLower(strings.TrimSpace(sql))

	// Introspection: tables (information_schema.tables but NOT table_constraints)
	if strings.Contains(trimmed, "information_schema.tables") && !strings.Contains(trimmed, "table_constraints") {
		return []map[string]any{
			{"table_name": "organization"},
			{"table_name": "user"},
		}, nil
	}

	// Introspection: columns (information_schema.columns but NOT table_constraints)
	if strings.Contains(trimmed, "information_schema.columns") && !strings.Contains(trimmed, "table_constraints") {
		return []map[string]any{
			{"table_name": "organization", "column_name": "id", "data_type": "uuid", "udt_name": "uuid", "is_nullable": "NO", "column_default": "gen_random_uuid()"},
			{"table_name": "organization", "column_name": "name", "data_type": "text", "udt_name": "text", "is_nullable": "NO", "column_default": ""},
			{"table_name": "user", "column_name": "id", "data_type": "uuid", "udt_name": "uuid", "is_nullable": "NO", "column_default": "gen_random_uuid()"},
			{"table_name": "user", "column_name": "email", "data_type": "text", "udt_name": "text", "is_nullable": "NO", "column_default": ""},
			{"table_name": "user", "column_name": "name", "data_type": "text", "udt_name": "text", "is_nullable": "NO", "column_default": ""},
			{"table_name": "user", "column_name": "organization_id", "data_type": "uuid", "udt_name": "uuid", "is_nullable": "NO", "column_default": ""},
		}, nil
	}

	// Introspection: foreign keys (constraint_type = 'FOREIGN KEY')
	if strings.Contains(trimmed, "foreign key") {
		return []map[string]any{
			{"from_table": "user", "from_column": "organization_id", "to_table": "organization", "to_column": "id", "is_nullable": "NO"},
		}, nil
	}

	// Introspection: primary keys (constraint_type = 'PRIMARY KEY')
	if strings.Contains(trimmed, "primary key") {
		return []map[string]any{
			{"table_name": "organization", "column_name": "id"},
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
		id := fmt.Sprintf("mock-id-%d", m.insertCount)
		m.mu.Unlock()

		record := map[string]any{"id": id}
		// Parse columns from SQL and match with params
		colMatch := strings.Index(sql, "(")
		if colMatch >= 0 {
			colEnd := strings.Index(sql[colMatch:], ")")
			if colEnd >= 0 {
				colStr := sql[colMatch+1 : colMatch+colEnd]
				cols := strings.Split(colStr, ",")
				for i, col := range cols {
					col = strings.TrimSpace(col)
					col = strings.Trim(col, "\"")
					if i < len(params) {
						record[col] = params[i]
					}
				}
			}
		}
		return []map[string]any{record}, nil
	}

	// DELETE/UPDATE: return empty
	return []map[string]any{}, nil
}

func (m *factoryMockExecutor) Transaction(ctx context.Context, fn func(tx SQLExecutor) error) error {
	return fn(m)
}

func (m *factoryMockExecutor) getQueries() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := make([]string, len(m.queries))
	copy(result, m.queries)
	return result
}

func clearCache() {
	introspectionCacheMu.Lock()
	introspectionCache = make(map[*HandlerConfig]*IntrospectionResult)
	introspectionCacheMu.Unlock()
}

func signedReq(body map[string]any, secret string) HandlerRequest {
	bodyBytes, _ := json.Marshal(body)
	bodyStr := string(bodyBytes)
	return HandlerRequest{
		Body:    bodyStr,
		Headers: map[string]string{"x-signature": SignBody(bodyStr, secret)},
	}
}

func TestFactoryCreate(t *testing.T) {
	clearCache()

	factoryCreateCalled := false
	var receivedData map[string]any

	executor := &factoryMockExecutor{}
	config := &HandlerConfig{
		Executor:      executor,
		ScopeField:    "organizationId",
		SharedSecret:  "shared",
		SigningSecret: "signing",
		Dialect:       "postgres",
		Factories: FactoryRegistry{
			"Organization": {
				Create: func(data map[string]any, ctx FactoryContext) (map[string]any, error) {
					factoryCreateCalled = true
					receivedData = data
					return map[string]any{"id": "factory-org-1", "name": data["name"]}, nil
				},
			},
		},
	}

	req := signedReq(map[string]any{
		"action":    "up",
		"create":    map[string]any{"Organization": []any{map[string]any{"name": "FactoryOrg"}}},
		"testRunId": "run-factory",
	}, "shared")

	resp := HandleRequest(context.Background(), config, req)
	if resp.Status != 200 {
		t.Fatalf("expected 200, got %d: %v", resp.Status, resp.Body)
	}

	if !factoryCreateCalled {
		t.Fatal("expected factory Create to be called")
	}
	if receivedData["name"] != "FactoryOrg" {
		t.Errorf("expected name 'FactoryOrg', got %v", receivedData["name"])
	}

	refs, _ := resp.Body["refs"].(map[string][]map[string]any)
	if refs == nil {
		t.Fatal("expected refs in response")
	}
	if len(refs["Organization"]) != 1 || refs["Organization"][0]["id"] != "factory-org-1" {
		t.Errorf("expected factory-org-1 in refs, got %v", refs["Organization"])
	}

	// No INSERT query for Organization should have been issued
	for _, q := range executor.getQueries() {
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(q)), "insert") && strings.Contains(strings.ToLower(q), "organization") {
			t.Error("expected no INSERT query for Organization when factory is used")
		}
	}
}

func TestFactoryHybrid(t *testing.T) {
	clearCache()

	factoryCreateCalled := false
	executor := &factoryMockExecutor{}
	config := &HandlerConfig{
		Executor:      executor,
		ScopeField:    "organizationId",
		SharedSecret:  "shared",
		SigningSecret: "signing",
		Dialect:       "postgres",
		Factories: FactoryRegistry{
			"Organization": {
				Create: func(data map[string]any, ctx FactoryContext) (map[string]any, error) {
					factoryCreateCalled = true
					return map[string]any{"id": "factory-org-1", "name": data["name"]}, nil
				},
			},
			// User has no factory — falls back to SQL
		},
	}

	req := signedReq(map[string]any{
		"action": "up",
		"create": map[string]any{
			"Organization": []any{map[string]any{"name": "HybridOrg"}},
			"User":         []any{map[string]any{"email": "test@example.com", "name": "Test"}},
		},
		"testRunId": "run-hybrid",
	}, "shared")

	resp := HandleRequest(context.Background(), config, req)
	if resp.Status != 200 {
		t.Fatalf("expected 200, got %d: %v", resp.Status, resp.Body)
	}

	if !factoryCreateCalled {
		t.Fatal("expected factory Create to be called for Organization")
	}

	// User should have been created via SQL INSERT
	userInsertFound := false
	for _, q := range executor.getQueries() {
		trimmed := strings.ToLower(strings.TrimSpace(q))
		if strings.HasPrefix(trimmed, "insert") && strings.Contains(trimmed, "\"user\"") {
			userInsertFound = true
			break
		}
	}
	if !userInsertFound {
		t.Error("expected SQL INSERT for User (no factory defined)")
	}
}

func TestFactoryFKPreResolution(t *testing.T) {
	clearCache()

	var userReceivedData map[string]any

	executor := &factoryMockExecutor{}
	config := &HandlerConfig{
		Executor:      executor,
		ScopeField:    "organizationId",
		SharedSecret:  "shared",
		SigningSecret: "signing",
		Dialect:       "postgres",
		Factories: FactoryRegistry{
			"Organization": {
				Create: func(data map[string]any, ctx FactoryContext) (map[string]any, error) {
					return map[string]any{"id": "resolved-org-id", "name": data["name"]}, nil
				},
			},
			"User": {
				Create: func(data map[string]any, ctx FactoryContext) (map[string]any, error) {
					userReceivedData = make(map[string]any)
					for k, v := range data {
						userReceivedData[k] = v
					}
					return map[string]any{"id": "user-1", "email": data["email"], "organizationId": data["organizationId"]}, nil
				},
			},
		},
	}

	// Nest User under Organization so tree resolver wires the FK
	req := signedReq(map[string]any{
		"action": "up",
		"create": map[string]any{
			"Organization": []any{map[string]any{"name": "Org", "User": []any{map[string]any{"email": "a@b.com", "name": "A"}}}},
		},
		"testRunId": "run-fk",
	}, "shared")

	resp := HandleRequest(context.Background(), config, req)
	if resp.Status != 200 {
		t.Fatalf("expected 200, got %d: %v", resp.Status, resp.Body)
	}

	if userReceivedData == nil {
		t.Fatal("expected User factory to be called")
	}
	// The User factory should receive the real org ID, not __temp_Organization_0
	if userReceivedData["organizationId"] != "resolved-org-id" {
		t.Errorf("expected organizationId to be 'resolved-org-id', got %v", userReceivedData["organizationId"])
	}
}

func TestFactoryMissingPK(t *testing.T) {
	clearCache()

	executor := &factoryMockExecutor{}
	config := &HandlerConfig{
		Executor:      executor,
		ScopeField:    "organizationId",
		SharedSecret:  "shared",
		SigningSecret: "signing",
		Dialect:       "postgres",
		Factories: FactoryRegistry{
			"Organization": {
				Create: func(data map[string]any, ctx FactoryContext) (map[string]any, error) {
					return map[string]any{"name": data["name"]}, nil // missing 'id'
				},
			},
		},
	}

	req := signedReq(map[string]any{
		"action":    "up",
		"create":    map[string]any{"Organization": []any{map[string]any{"name": "NoPK"}}},
		"testRunId": "run-nopk",
	}, "shared")

	resp := HandleRequest(context.Background(), config, req)
	if resp.Status != 500 {
		t.Fatalf("expected 500, got %d: %v", resp.Status, resp.Body)
	}
	if resp.Body["code"] != "FACTORY_MISSING_PK" {
		t.Errorf("expected FACTORY_MISSING_PK, got %v", resp.Body["code"])
	}
}

func TestFactoryTeardown(t *testing.T) {
	clearCache()

	var teardownCalls []string

	executor := &factoryMockExecutor{}
	config := &HandlerConfig{
		Executor:      executor,
		ScopeField:    "organizationId",
		SharedSecret:  "shared",
		SigningSecret: "signing",
		Dialect:       "postgres",
		Factories: FactoryRegistry{
			"Organization": {
				Create: func(data map[string]any, ctx FactoryContext) (map[string]any, error) {
					return map[string]any{"id": fmt.Sprintf("org-%s", data["name"]), "name": data["name"]}, nil
				},
				Teardown: func(record map[string]any, ctx FactoryContext) error {
					teardownCalls = append(teardownCalls, record["id"].(string))
					return nil
				},
			},
		},
	}

	// Create two orgs
	upReq := signedReq(map[string]any{
		"action":    "up",
		"create":    map[string]any{"Organization": []any{map[string]any{"name": "A"}, map[string]any{"name": "B"}}},
		"testRunId": "run-teardown",
	}, "shared")

	upResp := HandleRequest(context.Background(), config, upReq)
	if upResp.Status != 200 {
		t.Fatalf("expected 200 on up, got %d: %v", upResp.Status, upResp.Body)
	}

	refsToken, _ := upResp.Body["refsToken"].(string)
	if refsToken == "" {
		t.Fatal("expected refsToken in response")
	}

	// Teardown
	downReq := signedReq(map[string]any{
		"action":    "down",
		"refsToken": refsToken,
	}, "shared")

	downResp := HandleRequest(context.Background(), config, downReq)
	if downResp.Status != 200 {
		t.Fatalf("expected 200 on down, got %d: %v", downResp.Status, downResp.Body)
	}

	if len(teardownCalls) != 2 {
		t.Fatalf("expected 2 teardown calls, got %d", len(teardownCalls))
	}
	// Reverse order: B first, then A
	if teardownCalls[0] != "org-B" || teardownCalls[1] != "org-A" {
		t.Errorf("expected teardown in reverse order [org-B, org-A], got %v", teardownCalls)
	}
}

func TestFactoryTeardownFallbackToSQL(t *testing.T) {
	clearCache()

	executor := &factoryMockExecutor{}
	config := &HandlerConfig{
		Executor:      executor,
		ScopeField:    "organizationId",
		SharedSecret:  "shared",
		SigningSecret: "signing",
		Dialect:       "postgres",
		Factories: FactoryRegistry{
			"Organization": {
				Create: func(data map[string]any, ctx FactoryContext) (map[string]any, error) {
					return map[string]any{"id": "org-1", "name": data["name"]}, nil
				},
				// No Teardown — SQL DELETE should be used
			},
		},
	}

	upReq := signedReq(map[string]any{
		"action":    "up",
		"create":    map[string]any{"Organization": []any{map[string]any{"name": "Org"}}},
		"testRunId": "run-sql-td",
	}, "shared")

	upResp := HandleRequest(context.Background(), config, upReq)
	if upResp.Status != 200 {
		t.Fatalf("expected 200 on up, got %d: %v", upResp.Status, upResp.Body)
	}

	refsToken, _ := upResp.Body["refsToken"].(string)

	// Clear tracked queries before teardown
	executor.mu.Lock()
	executor.queries = nil
	executor.mu.Unlock()

	downReq := signedReq(map[string]any{
		"action":    "down",
		"refsToken": refsToken,
	}, "shared")

	downResp := HandleRequest(context.Background(), config, downReq)
	if downResp.Status != 200 {
		t.Fatalf("expected 200 on down, got %d: %v", downResp.Status, downResp.Body)
	}

	// SQL DELETE should have been used
	deleteFound := false
	for _, q := range executor.getQueries() {
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(q)), "delete") {
			deleteFound = true
			break
		}
	}
	if !deleteFound {
		t.Error("expected SQL DELETE when factory has no teardown")
	}
}

func TestFactoryContextHasRefs(t *testing.T) {
	clearCache()

	var userCtx *FactoryContext

	executor := &factoryMockExecutor{}
	config := &HandlerConfig{
		Executor:      executor,
		ScopeField:    "organizationId",
		SharedSecret:  "shared",
		SigningSecret: "signing",
		Dialect:       "postgres",
		Factories: FactoryRegistry{
			"Organization": {
				Create: func(data map[string]any, ctx FactoryContext) (map[string]any, error) {
					return map[string]any{"id": "org-ctx", "name": data["name"]}, nil
				},
			},
			"User": {
				Create: func(data map[string]any, ctx FactoryContext) (map[string]any, error) {
					ctxCopy := ctx
					userCtx = &ctxCopy
					return map[string]any{"id": "user-ctx", "email": data["email"], "organizationId": data["organizationId"]}, nil
				},
			},
		},
	}

	req := signedReq(map[string]any{
		"action": "up",
		"create": map[string]any{
			"Organization": []any{map[string]any{"name": "Org"}},
			"User":         []any{map[string]any{"email": "x@y.com", "name": "X"}},
		},
		"testRunId": "run-ctx",
	}, "shared")

	resp := HandleRequest(context.Background(), config, req)
	if resp.Status != 200 {
		t.Fatalf("expected 200, got %d: %v", resp.Status, resp.Body)
	}

	if userCtx == nil {
		t.Fatal("expected User factory context to be captured")
	}

	// By the time User factory runs, Organization should already be in refs
	orgRefs := userCtx.Refs["Organization"]
	if len(orgRefs) != 1 {
		t.Fatalf("expected 1 Organization in refs, got %d", len(orgRefs))
	}
	if orgRefs[0]["id"] != "org-ctx" {
		t.Errorf("expected org-ctx, got %v", orgRefs[0]["id"])
	}
	if userCtx.TestRunID != "run-ctx" {
		t.Errorf("expected testRunId 'run-ctx', got %v", userCtx.TestRunID)
	}
}
