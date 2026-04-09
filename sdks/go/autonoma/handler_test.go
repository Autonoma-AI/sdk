package autonoma

import (
	"context"
	"encoding/json"
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
