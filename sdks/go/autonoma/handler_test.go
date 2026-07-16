package autonoma

import (
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
)

// --- Test input structs ---

type OrganizationInput struct {
	Name string `json:"name"`
}

type UserInput struct {
	Email          string `json:"email"`
	Name           string `json:"name,omitempty"`
	OrganizationID string `json:"organizationId,omitempty"`
}

// --- Helpers ---

func signedReq(body map[string]any, secret string) HandlerRequest {
	bodyBytes, _ := json.Marshal(body)
	bodyStr := string(bodyBytes)
	return HandlerRequest{
		Body:    bodyStr,
		Headers: map[string]string{"x-signature": SignBody(bodyStr, secret)},
	}
}

// --- Tests ---

func TestHandleRequest_InvalidSignature(t *testing.T) {
	config := &HandlerConfig{
		SharedSecret:  "shared",
		SigningSecret: "signing",
	}
	req := HandlerRequest{
		Body:    `{"action":"discover"}`,
		Headers: map[string]string{"x-signature": "invalid"},
	}

	resp := HandleRequest(config, req)
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

	resp := HandleRequest(config, req)
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

	resp := HandleRequest(config, req)
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

	resp := HandleRequest(config, req)
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

	resp := HandleRequest(config, req)
	if resp.Status != 403 {
		t.Errorf("expected 403, got %d", resp.Status)
	}
	if resp.Body["code"] != "INVALID_REFS_TOKEN" {
		t.Errorf("expected INVALID_REFS_TOKEN, got %v", resp.Body["code"])
	}
}

func TestDiscover(t *testing.T) {
	config := &HandlerConfig{
		SharedSecret:  "shared",
		SigningSecret: "signing",
		ScopeField:    "organizationId",
		Factories: FactoryRegistry{
			"Organization": {
				InputStruct: reflect.TypeOf(OrganizationInput{}),
				Create: func(input interface{}, ctx FactoryContext) (map[string]any, error) {
					return nil, nil
				},
			},
			"User": {
				InputStruct: reflect.TypeOf(UserInput{}),
				Create: func(input interface{}, ctx FactoryContext) (map[string]any, error) {
					return nil, nil
				},
			},
		},
	}

	req := signedReq(map[string]any{"action": "discover"}, "shared")
	resp := HandleRequest(config, req)
	if resp.Status != 200 {
		t.Fatalf("expected 200, got %d: %v", resp.Status, resp.Body)
	}

	schema, ok := resp.Body["schema"].(map[string]any)
	if !ok {
		t.Fatalf("expected schema in response, got %T", resp.Body["schema"])
	}
	models, ok := schema["models"].([]map[string]any)
	if !ok {
		t.Fatalf("expected models array, got %T", schema["models"])
	}
	if len(models) != 2 {
		t.Fatalf("expected 2 models, got %d", len(models))
	}

	// Should have empty edges and relations.
	edges, _ := schema["edges"].([]map[string]any)
	if len(edges) != 0 {
		t.Errorf("expected empty edges, got %d", len(edges))
	}
	relations, _ := schema["relations"].([]map[string]any)
	if len(relations) != 0 {
		t.Errorf("expected empty relations, got %d", len(relations))
	}
	if schema["scopeField"] != "organizationId" {
		t.Errorf("expected scopeField=organizationId, got %v", schema["scopeField"])
	}
}

func TestFactoryCreate(t *testing.T) {
	factoryCreateCalled := false
	var receivedInput interface{}

	config := &HandlerConfig{
		ScopeField:    "organizationId",
		SharedSecret:  "shared",
		SigningSecret: "signing",
		Factories: FactoryRegistry{
			"Organization": {
				InputStruct: reflect.TypeOf(OrganizationInput{}),
				Create: func(input interface{}, ctx FactoryContext) (map[string]any, error) {
					factoryCreateCalled = true
					receivedInput = input
					org := input.(*OrganizationInput)
					return map[string]any{"id": "factory-org-1", "name": org.Name}, nil
				},
			},
		},
	}

	req := signedReq(map[string]any{
		"action":    "up",
		"create":    map[string]any{"Organization": []any{map[string]any{"name": "FactoryOrg"}}},
		"testRunId": "run-factory",
	}, "shared")

	resp := HandleRequest(config, req)
	if resp.Status != 200 {
		t.Fatalf("expected 200, got %d: %v", resp.Status, resp.Body)
	}

	if !factoryCreateCalled {
		t.Fatal("expected factory Create to be called")
	}
	org, ok := receivedInput.(*OrganizationInput)
	if !ok {
		t.Fatalf("expected *OrganizationInput, got %T", receivedInput)
	}
	if org.Name != "FactoryOrg" {
		t.Errorf("expected name 'FactoryOrg', got %v", org.Name)
	}

	refs, _ := resp.Body["refs"].(map[string][]map[string]any)
	if refs == nil {
		t.Fatal("expected refs in response")
	}
	if len(refs["Organization"]) != 1 || refs["Organization"][0]["id"] != "factory-org-1" {
		t.Errorf("expected factory-org-1 in refs, got %v", refs["Organization"])
	}
}

func TestFactoryFKPreResolution(t *testing.T) {
	var userReceivedInput interface{}

	config := &HandlerConfig{
		ScopeField:    "organizationId",
		SharedSecret:  "shared",
		SigningSecret: "signing",
		Factories: FactoryRegistry{
			"Organization": {
				InputStruct: reflect.TypeOf(OrganizationInput{}),
				Create: func(input interface{}, ctx FactoryContext) (map[string]any, error) {
					org := input.(*OrganizationInput)
					return map[string]any{"id": "resolved-org-id", "name": org.Name}, nil
				},
			},
			"User": {
				InputStruct: reflect.TypeOf(UserInput{}),
				Create: func(input interface{}, ctx FactoryContext) (map[string]any, error) {
					userReceivedInput = input
					u := input.(*UserInput)
					return map[string]any{"id": "user-1", "email": u.Email, "organizationId": u.OrganizationID}, nil
				},
			},
		},
	}

	// Use _alias/_ref to wire Organization -> User
	req := signedReq(map[string]any{
		"action": "up",
		"create": map[string]any{
			"Organization": []any{map[string]any{"name": "Org", "_alias": "org1"}},
			"User":         []any{map[string]any{"email": "a@b.com", "name": "A", "organizationId": map[string]any{"_ref": "org1"}}},
		},
		"testRunId": "run-fk",
	}, "shared")

	resp := HandleRequest(config, req)
	if resp.Status != 200 {
		t.Fatalf("expected 200, got %d: %v", resp.Status, resp.Body)
	}

	if userReceivedInput == nil {
		t.Fatal("expected User factory to be called")
	}
	u := userReceivedInput.(*UserInput)
	if u.OrganizationID != "resolved-org-id" {
		t.Errorf("expected organizationId to be 'resolved-org-id', got %v", u.OrganizationID)
	}
}

func TestFactoryMissingPK(t *testing.T) {
	config := &HandlerConfig{
		ScopeField:    "organizationId",
		SharedSecret:  "shared",
		SigningSecret: "signing",
		Factories: FactoryRegistry{
			"Organization": {
				InputStruct: reflect.TypeOf(OrganizationInput{}),
				Create: func(input interface{}, ctx FactoryContext) (map[string]any, error) {
					org := input.(*OrganizationInput)
					return map[string]any{"name": org.Name}, nil // missing 'id'
				},
			},
		},
	}

	req := signedReq(map[string]any{
		"action":    "up",
		"create":    map[string]any{"Organization": []any{map[string]any{"name": "NoPK"}}},
		"testRunId": "run-nopk",
	}, "shared")

	resp := HandleRequest(config, req)
	if resp.Status != 500 {
		t.Fatalf("expected 500, got %d: %v", resp.Status, resp.Body)
	}
	if resp.Body["code"] != "FACTORY_MISSING_PK" {
		t.Errorf("expected FACTORY_MISSING_PK, got %v", resp.Body["code"])
	}
}

func TestFactoryTeardown(t *testing.T) {
	var teardownCalls []string

	config := &HandlerConfig{
		ScopeField:    "organizationId",
		SharedSecret:  "shared",
		SigningSecret: "signing",
		Factories: FactoryRegistry{
			"Organization": {
				InputStruct: reflect.TypeOf(OrganizationInput{}),
				Create: func(input interface{}, ctx FactoryContext) (map[string]any, error) {
					org := input.(*OrganizationInput)
					return map[string]any{"id": fmt.Sprintf("org-%s", org.Name), "name": org.Name}, nil
				},
				Teardown: func(record interface{}, ctx FactoryContext) error {
					rec := record.(map[string]any)
					teardownCalls = append(teardownCalls, rec["id"].(string))
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

	upResp := HandleRequest(config, upReq)
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

	downResp := HandleRequest(config, downReq)
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

func TestFactoryContextHasRefs(t *testing.T) {
	var userCtx *FactoryContext

	config := &HandlerConfig{
		ScopeField:    "organizationId",
		SharedSecret:  "shared",
		SigningSecret: "signing",
		Factories: FactoryRegistry{
			"Organization": {
				InputStruct: reflect.TypeOf(OrganizationInput{}),
				Create: func(input interface{}, ctx FactoryContext) (map[string]any, error) {
					org := input.(*OrganizationInput)
					return map[string]any{"id": "org-ctx", "name": org.Name}, nil
				},
			},
			"User": {
				InputStruct: reflect.TypeOf(UserInput{}),
				Create: func(input interface{}, ctx FactoryContext) (map[string]any, error) {
					ctxCopy := ctx
					userCtx = &ctxCopy
					u := input.(*UserInput)
					return map[string]any{"id": "user-ctx", "email": u.Email, "organizationId": u.OrganizationID}, nil
				},
			},
		},
	}

	req := signedReq(map[string]any{
		"action": "up",
		"create": map[string]any{
			"Organization": []any{map[string]any{"name": "Org", "_alias": "org1"}},
			"User":         []any{map[string]any{"email": "x@y.com", "name": "X", "organizationId": map[string]any{"_ref": "org1"}}},
		},
		"testRunId": "run-ctx",
	}, "shared")

	resp := HandleRequest(config, req)
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

func TestAfterUpHook(t *testing.T) {
	config := &HandlerConfig{
		ScopeField:    "organizationId",
		SharedSecret:  "shared",
		SigningSecret: "signing",
		Factories: FactoryRegistry{
			"User": {
				InputStruct: reflect.TypeOf(UserInput{}),
				Create: func(input interface{}, ctx FactoryContext) (map[string]any, error) {
					u := input.(*UserInput)
					return map[string]any{"id": "u1", "email": u.Email}, nil
				},
			},
		},
		AfterUp: func(ctx HookContext, auth map[string]any) (map[string]any, error) {
			auth["X-Custom"] = "enriched"
			return auth, nil
		},
	}

	req := signedReq(map[string]any{
		"action":    "up",
		"create":    map[string]any{"User": []any{map[string]any{"email": "test@test.com"}}},
		"testRunId": "run-123",
	}, "shared")

	resp := HandleRequest(config, req)
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
	hookCalled := false
	var capturedScenarioName string

	config := &HandlerConfig{
		ScopeField:    "organizationId",
		SharedSecret:  "shared",
		SigningSecret: "signing",
		Factories: FactoryRegistry{
			"User": {
				InputStruct: reflect.TypeOf(UserInput{}),
				Create: func(input interface{}, ctx FactoryContext) (map[string]any, error) {
					return nil, nil
				},
			},
		},
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

	downReq := signedReq(map[string]any{
		"action":    "down",
		"refsToken": refsToken,
	}, "shared")

	resp := HandleRequest(config, downReq)
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

func TestEndpointAlwaysEnabled(t *testing.T) {
	// AllowProduction is a deprecated no-op: the endpoint serves whether the
	// flag is absent (zero value, false) or explicitly false.
	config := &HandlerConfig{
		SharedSecret:    "shared",
		SigningSecret:   "signing",
		AllowProduction: false,
		Factories:       FactoryRegistry{},
	}
	req := signedReq(map[string]any{"action": "discover"}, "shared")

	resp := HandleRequest(config, req)
	if resp.Status != 200 {
		t.Fatalf("expected 200 even with AllowProduction false, got %d: %v", resp.Status, resp.Body)
	}
}

func TestSchemaToWire(t *testing.T) {
	schema := SchemaInfo{
		Models: []ModelInfo{
			{
				Name:      "User",
				TableName: "users",
				Fields: []FieldInfo{
					{Name: "id", Type: "string", IsRequired: false, IsId: true, HasDefault: true},
					{Name: "email", Type: "string", IsRequired: true, IsId: false, HasDefault: false},
				},
			},
		},
		Edges:      []FKEdge{},
		Relations:  []SchemaRelation{},
		ScopeField: "organizationId",
	}

	result := SchemaToWire(&schema)
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

func TestNoFactoryRegistered(t *testing.T) {
	config := &HandlerConfig{
		ScopeField:    "organizationId",
		SharedSecret:  "shared",
		SigningSecret: "signing",
		Factories:     FactoryRegistry{},
	}

	req := signedReq(map[string]any{
		"action":    "up",
		"create":    map[string]any{"Organization": []any{map[string]any{"name": "Org"}}},
		"testRunId": "run-no-factory",
	}, "shared")

	resp := HandleRequest(config, req)
	if resp.Status != 400 {
		t.Fatalf("expected 400, got %d: %v", resp.Status, resp.Body)
	}
	if resp.Body["code"] != "INVALID_BODY" {
		t.Errorf("expected INVALID_BODY, got %v", resp.Body["code"])
	}
}

func TestTeardownWithDependencies(t *testing.T) {
	var teardownOrder []string

	config := &HandlerConfig{
		ScopeField:    "organizationId",
		SharedSecret:  "shared",
		SigningSecret: "signing",
		Factories: FactoryRegistry{
			"Organization": {
				InputStruct: reflect.TypeOf(OrganizationInput{}),
				Create: func(input interface{}, ctx FactoryContext) (map[string]any, error) {
					org := input.(*OrganizationInput)
					return map[string]any{"id": "org-1", "name": org.Name}, nil
				},
				Teardown: func(record interface{}, ctx FactoryContext) error {
					rec := record.(map[string]any)
					teardownOrder = append(teardownOrder, "Organization:"+rec["id"].(string))
					return nil
				},
			},
			"User": {
				InputStruct: reflect.TypeOf(UserInput{}),
				Create: func(input interface{}, ctx FactoryContext) (map[string]any, error) {
					u := input.(*UserInput)
					return map[string]any{"id": "user-1", "email": u.Email, "organizationId": u.OrganizationID}, nil
				},
				Teardown: func(record interface{}, ctx FactoryContext) error {
					rec := record.(map[string]any)
					teardownOrder = append(teardownOrder, "User:"+rec["id"].(string))
					return nil
				},
			},
		},
	}

	// Create with alias/ref dependencies
	upReq := signedReq(map[string]any{
		"action": "up",
		"create": map[string]any{
			"Organization": []any{map[string]any{"name": "Org", "_alias": "org1"}},
			"User":         []any{map[string]any{"email": "a@b.com", "organizationId": map[string]any{"_ref": "org1"}}},
		},
		"testRunId": "run-dep-td",
	}, "shared")

	upResp := HandleRequest(config, upReq)
	if upResp.Status != 200 {
		t.Fatalf("expected 200 on up, got %d: %v", upResp.Status, upResp.Body)
	}

	refsToken, _ := upResp.Body["refsToken"].(string)

	downReq := signedReq(map[string]any{
		"action":    "down",
		"refsToken": refsToken,
	}, "shared")

	downResp := HandleRequest(config, downReq)
	if downResp.Status != 200 {
		t.Fatalf("expected 200 on down, got %d: %v", downResp.Status, downResp.Body)
	}

	// User should be torn down before Organization (reverse of creation order)
	if len(teardownOrder) != 2 {
		t.Fatalf("expected 2 teardown calls, got %d: %v", len(teardownOrder), teardownOrder)
	}
	if teardownOrder[0] != "User:user-1" {
		t.Errorf("expected User to be torn down first, got %v", teardownOrder[0])
	}
	if teardownOrder[1] != "Organization:org-1" {
		t.Errorf("expected Organization to be torn down second, got %v", teardownOrder[1])
	}
}
