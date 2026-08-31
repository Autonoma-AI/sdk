package autonoma

import (
	"encoding/json"
	"strings"
	"testing"
)

// --- Helpers ---

func signedReq(body map[string]any, secret string) HandlerRequest {
	bodyBytes, _ := json.Marshal(body)
	bodyStr := string(bodyBytes)
	return HandlerRequest{
		Body:    bodyStr,
		Headers: map[string]string{"x-signature": SignBody(bodyStr, secret)},
	}
}

func testScenarios(downCalls *[]string) []ScenarioDefinition {
	return []ScenarioDefinition{
		DefineScenario(ScenarioDefinition{
			Name:        "standard",
			Description: "A standard seeded environment",
			Up: func(ctx ScenarioUpContext) (ScenarioUpResult, error) {
				return ScenarioUpResult{
					Auth:     &AuthResult{Headers: map[string]string{"Authorization": "Bearer " + ctx.TestRunID}},
					Teardown: map[string]any{"userId": "user-" + ctx.TestRunID},
				}, nil
			},
			Down: func(ctx ScenarioDownContext) error {
				if downCalls != nil {
					*downCalls = append(*downCalls, ctx.Name+":"+ctx.TestRunID)
				}
				return nil
			},
		}),
		DefineScenario(ScenarioDefinition{
			Name:        "empty",
			Description: "Nothing seeded",
			Up:          func(ctx ScenarioUpContext) (ScenarioUpResult, error) { return ScenarioUpResult{}, nil },
		}),
	}
}

func baseConfig(downCalls *[]string) *HandlerConfig {
	return &HandlerConfig{
		SharedSecret:  "shared",
		SigningSecret: "signing",
		Scenarios:     testScenarios(downCalls),
	}
}

// --- Request gate ---

func TestHandleRequest_InvalidSignature(t *testing.T) {
	resp := HandleRequest(baseConfig(nil), HandlerRequest{
		Body:    `{"action":"discover"}`,
		Headers: map[string]string{"x-signature": "invalid"},
	})
	if resp.Status != 401 || resp.Body["code"] != "INVALID_SIGNATURE" {
		t.Errorf("expected 401 INVALID_SIGNATURE, got %d %v", resp.Status, resp.Body["code"])
	}
}

func TestHandleRequest_SameSecrets(t *testing.T) {
	config := &HandlerConfig{SharedSecret: "same", SigningSecret: "same"}
	resp := HandleRequest(config, HandlerRequest{Body: `{"action":"discover"}`, Headers: map[string]string{"x-signature": "x"}})
	if resp.Status != 500 || resp.Body["code"] != "SAME_SECRETS" {
		t.Errorf("expected 500 SAME_SECRETS, got %d %v", resp.Status, resp.Body["code"])
	}
}

func TestHandleRequest_InvalidBody(t *testing.T) {
	resp := HandleRequest(baseConfig(nil), signedReqRaw("not json", "shared"))
	if resp.Status != 400 || resp.Body["code"] != "INVALID_BODY" {
		t.Errorf("expected 400 INVALID_BODY, got %d %v", resp.Status, resp.Body["code"])
	}
}

func signedReqRaw(body, secret string) HandlerRequest {
	return HandlerRequest{Body: body, Headers: map[string]string{"x-signature": SignBody(body, secret)}}
}

func TestHandleRequest_UnknownAction(t *testing.T) {
	resp := HandleRequest(baseConfig(nil), signedReq(map[string]any{"action": "nonexistent"}, "shared"))
	if resp.Status != 400 || resp.Body["code"] != "UNKNOWN_ACTION" {
		t.Errorf("expected 400 UNKNOWN_ACTION, got %d %v", resp.Status, resp.Body["code"])
	}
}

// --- discover ---

func TestDiscover(t *testing.T) {
	resp := HandleRequest(baseConfig(nil), signedReq(map[string]any{"action": "discover"}, "shared"))
	if resp.Status != 200 {
		t.Fatalf("expected 200, got %d: %v", resp.Status, resp.Body)
	}
	if resp.Body["version"] != "2.0" {
		t.Errorf("expected version 2.0, got %v", resp.Body["version"])
	}

	scenarios, ok := resp.Body["scenarios"].([]map[string]any)
	if !ok {
		t.Fatalf("expected scenarios array, got %T", resp.Body["scenarios"])
	}
	if len(scenarios) != 2 {
		t.Fatalf("expected 2 scenarios, got %d", len(scenarios))
	}
	if scenarios[0]["name"] != "standard" {
		t.Errorf("expected first scenario 'standard', got %v", scenarios[0]["name"])
	}
	if desc, _ := scenarios[0]["description"].(string); desc == "" {
		t.Errorf("expected non-empty description")
	}
	// discover must never leak a create/schema shape.
	if _, hasSchema := resp.Body["schema"]; hasSchema {
		t.Errorf("discover must not include a schema in v2")
	}
}

// --- up ---

func TestUp_ReturnsEnvelope(t *testing.T) {
	body := map[string]any{"action": "up", "scenario": map[string]any{"name": "standard"}, "testRunId": "run-1"}
	resp := HandleRequest(baseConfig(nil), signedReq(body, "shared"))
	if resp.Status != 200 {
		t.Fatalf("expected 200, got %d: %v", resp.Status, resp.Body)
	}
	if resp.Body["version"] != "2.0" {
		t.Errorf("expected version 2.0, got %v", resp.Body["version"])
	}
	token, _ := resp.Body["teardownToken"].(string)
	if len(strings.Split(token, ".")) != 3 {
		t.Errorf("expected 3-part teardownToken, got %q", token)
	}
	if resp.Body["expiresInSeconds"] != 3600 {
		t.Errorf("expected default expiresInSeconds 3600, got %v", resp.Body["expiresInSeconds"])
	}
	// The duplicated plaintext refs and the old refsToken field are gone.
	if _, has := resp.Body["refs"]; has {
		t.Errorf("expected no plaintext refs on the up envelope")
	}
	if _, has := resp.Body["refsToken"]; has {
		t.Errorf("expected no refsToken on the up envelope")
	}
	auth, ok := resp.Body["auth"].(*AuthResult)
	if !ok || auth.Headers["Authorization"] != "Bearer run-1" {
		t.Errorf("expected auth headers, got %v", resp.Body["auth"])
	}
}

func TestUp_CustomExpires(t *testing.T) {
	config := baseConfig(nil)
	config.ExpiresInSeconds = 60
	body := map[string]any{"action": "up", "scenario": map[string]any{"name": "empty"}, "testRunId": "r"}
	resp := HandleRequest(config, signedReq(body, "shared"))
	if resp.Body["expiresInSeconds"] != 60 {
		t.Errorf("expected expiresInSeconds 60, got %v", resp.Body["expiresInSeconds"])
	}
	// The empty scenario returns nothing, so no auth on the envelope.
	if _, has := resp.Body["auth"]; has {
		t.Errorf("expected no auth for empty scenario")
	}
}

func TestUp_UnknownEnvironment(t *testing.T) {
	body := map[string]any{"action": "up", "scenario": map[string]any{"name": "does-not-exist"}, "testRunId": "r"}
	resp := HandleRequest(baseConfig(nil), signedReq(body, "shared"))
	if resp.Status != 400 || resp.Body["code"] != "UNKNOWN_ENVIRONMENT" {
		t.Errorf("expected 400 UNKNOWN_ENVIRONMENT, got %d %v", resp.Status, resp.Body["code"])
	}
}

func TestUp_MissingScenarioName(t *testing.T) {
	resp := HandleRequest(baseConfig(nil), signedReq(map[string]any{"action": "up", "testRunId": "r"}, "shared"))
	if resp.Status != 400 || resp.Body["code"] != "INVALID_BODY" {
		t.Errorf("expected 400 INVALID_BODY, got %d %v", resp.Status, resp.Body["code"])
	}
}

// --- down ---

func TestDown_ValidToken(t *testing.T) {
	var downCalls []string
	config := baseConfig(&downCalls)

	upBody := map[string]any{"action": "up", "scenario": map[string]any{"name": "standard"}, "testRunId": "run-td"}
	upResp := HandleRequest(config, signedReq(upBody, "shared"))
	token, _ := upResp.Body["teardownToken"].(string)

	downBody := map[string]any{"action": "down", "teardownToken": token, "testRunId": "run-td"}
	downResp := HandleRequest(config, signedReq(downBody, "shared"))
	if downResp.Status != 200 || downResp.Body["ok"] != true {
		t.Fatalf("expected 200 ok:true, got %d %v", downResp.Status, downResp.Body)
	}
	if len(downCalls) != 1 || downCalls[0] != "standard:run-td" {
		t.Errorf("expected down called once for standard:run-td, got %v", downCalls)
	}
}

func TestDown_RoutesByTokenEnvironment(t *testing.T) {
	var downCalls []string
	config := baseConfig(&downCalls)

	upBody := map[string]any{"action": "up", "scenario": map[string]any{"name": "standard"}, "testRunId": "run-tok"}
	token, _ := HandleRequest(config, signedReq(upBody, "shared")).Body["teardownToken"].(string)

	// No scenario.name on the down request - the handler must recover it from
	// the verified token's environment.
	downBody := map[string]any{"action": "down", "teardownToken": token}
	downResp := HandleRequest(config, signedReq(downBody, "shared"))
	if downResp.Status != 200 {
		t.Fatalf("expected 200, got %d %v", downResp.Status, downResp.Body)
	}
	if len(downCalls) != 1 || downCalls[0] != "standard:run-tok" {
		t.Errorf("expected down routed via token environment, got %v", downCalls)
	}
}

func TestDown_InvalidTeardownToken(t *testing.T) {
	resp := HandleRequest(baseConfig(nil), signedReq(map[string]any{"action": "down", "teardownToken": "tampered.token.value"}, "shared"))
	if resp.Status != 403 || resp.Body["code"] != "INVALID_TEARDOWN_TOKEN" {
		t.Errorf("expected 403 INVALID_TEARDOWN_TOKEN, got %d %v", resp.Status, resp.Body["code"])
	}
}

func TestDown_MissingTeardownToken(t *testing.T) {
	resp := HandleRequest(baseConfig(nil), signedReq(map[string]any{"action": "down"}, "shared"))
	if resp.Status != 400 || resp.Body["code"] != "INVALID_BODY" {
		t.Errorf("expected 400 INVALID_BODY, got %d %v", resp.Status, resp.Body["code"])
	}
}

func TestEndpointAlwaysEnabled(t *testing.T) {
	// AllowProduction is a deprecated no-op: discover serves regardless.
	config := baseConfig(nil)
	config.AllowProduction = false
	resp := HandleRequest(config, signedReq(map[string]any{"action": "discover"}, "shared"))
	if resp.Status != 200 {
		t.Fatalf("expected 200 with AllowProduction false, got %d", resp.Status)
	}
}
