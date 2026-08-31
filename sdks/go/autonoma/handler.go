package autonoma

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"

	"github.com/google/uuid"
)

//go:generate sh -c "printf 'package autonoma\n\n// Code generated from protocol/version.txt. DO NOT EDIT.\nconst ProtocolVersion = \"%s\"\n' \"$(cat ../../../protocol/version.txt | tr -d '\\n')\" > protocol_version_gen.go"

const defaultExpiresInSeconds = 3600

// One-shot runtime signal for users who never see the deprecation note on the
// config field.
var warnedDeprecatedAllowProduction sync.Once

func buildSdkMeta(config *HandlerConfig) map[string]any {
	sdk := config.SDK
	if sdk == nil {
		sdk = &SdkInfo{}
	}
	orm := sdk.Orm
	if orm == "" {
		orm = "unknown"
	}
	server := sdk.Server
	if server == "" {
		server = "unknown"
	}
	return map[string]any{
		"version": ProtocolVersion,
		"sdk": map[string]any{
			"language": "go",
			"orm":      orm,
			"server":   server,
		},
	}
}

// HandleRequest is the main entry point for processing Autonoma protocol requests.
func HandleRequest(config *HandlerConfig, req HandlerRequest) HandlerResponse {
	resp, err := handleRequestInner(config, req)
	if err != nil {
		if ae, ok := err.(*AutonomaError); ok {
			return HandlerResponse{
				Status: ae.Status,
				Body:   map[string]any{"error": ae.Message, "code": ae.Code},
			}
		}
		return HandlerResponse{
			Status: 500,
			Body:   map[string]any{"error": err.Error(), "code": "INTERNAL_ERROR"},
		}
	}
	return *resp
}

func handleRequestInner(config *HandlerConfig, req HandlerRequest) (*HandlerResponse, error) {
	if config.AllowProduction {
		warnedDeprecatedAllowProduction.Do(func() {
			fmt.Fprintln(os.Stderr,
				"[autonoma] AllowProduction is deprecated and ignored - the endpoint is always enabled")
		})
	}

	if config.SharedSecret == config.SigningSecret {
		return nil, ErrSameSecrets()
	}

	signature := req.Headers["x-signature"]
	if signature == "" {
		signature = req.Headers["X-Signature"]
	}
	if !VerifySignature(req.Body, signature, config.SharedSecret) {
		return nil, ErrInvalidSignature()
	}

	var body map[string]any
	if err := json.Unmarshal([]byte(req.Body), &body); err != nil {
		return nil, ErrInvalidBody("invalid JSON")
	}

	action, _ := body["action"].(string)
	if action == "" {
		return nil, ErrInvalidBody(`missing action. expected one of "discover", "up" or "down"`)
	}

	switch action {
	case "discover":
		return handleDiscover(config)
	case "up":
		return handleUp(config, body)
	case "down":
		return handleDown(config, body)
	default:
		return nil, ErrUnknownAction(action)
	}
}

// ---------------------------------------------------------------------------
// discover
// ---------------------------------------------------------------------------

func handleDiscover(config *HandlerConfig) (*HandlerResponse, error) {
	scenarios := make([]map[string]any, 0, len(config.Scenarios))
	for _, s := range config.Scenarios {
		scenarios = append(scenarios, map[string]any{
			"name":        s.Name,
			"description": s.Description,
		})
	}

	resp := buildSdkMeta(config)
	resp["scenarios"] = scenarios

	return &HandlerResponse{Status: 200, Body: resp}, nil
}

// ---------------------------------------------------------------------------
// up
// ---------------------------------------------------------------------------

func handleUp(config *HandlerConfig, body map[string]any) (*HandlerResponse, error) {
	name := readScenarioName(body)
	if name == "" {
		return nil, ErrInvalidBody(`missing "scenario.name" in request body`)
	}

	scenario := findScenario(config, name)
	if scenario == nil {
		return nil, ErrUnknownEnvironment(name)
	}
	if scenario.Up == nil {
		return nil, ErrInvalidBody(fmt.Sprintf(`scenario %q has no Up function`, name))
	}

	testRunID, _ := body["testRunId"].(string)
	if testRunID == "" {
		testRunID = uuid.New().String()
	}

	result, err := scenario.Up(ScenarioUpContext{TestRunID: testRunID})
	if err != nil {
		return nil, err
	}

	teardown := result.Teardown
	if teardown == nil {
		teardown = map[string]any{}
	}
	teardownToken, err := SignRefs(RefsPayload{
		Refs:        teardown,
		TestRunID:   testRunID,
		Environment: name,
	}, config.SigningSecret)
	if err != nil {
		return nil, err
	}

	expiresInSeconds := config.ExpiresInSeconds
	if expiresInSeconds == 0 {
		expiresInSeconds = defaultExpiresInSeconds
	}

	resp := buildSdkMeta(config)
	if result.Auth != nil {
		resp["auth"] = result.Auth
	}
	resp["teardownToken"] = teardownToken
	resp["expiresInSeconds"] = expiresInSeconds

	return &HandlerResponse{Status: 200, Body: resp}, nil
}

// ---------------------------------------------------------------------------
// down
// ---------------------------------------------------------------------------

func handleDown(config *HandlerConfig, body map[string]any) (*HandlerResponse, error) {
	teardownToken, _ := body["teardownToken"].(string)
	if teardownToken == "" {
		return nil, ErrInvalidBody("missing teardownToken")
	}

	payload, err := VerifyRefs(teardownToken, config.SigningSecret)
	if err != nil {
		return nil, ErrInvalidTeardownToken(err.Error())
	}

	teardown, _ := payload.Refs.(map[string]any)
	if teardown == nil {
		teardown = map[string]any{}
	}
	testRunID := payload.TestRunID

	// The verified token is authoritative for routing; any scenario name on the
	// request body is ignored.
	name := payload.Environment

	if name != "" {
		if scenario := findScenario(config, name); scenario != nil && scenario.Down != nil {
			if err := scenario.Down(ScenarioDownContext{
				Name:      name,
				Teardown:  teardown,
				TestRunID: testRunID,
			}); err != nil {
				return nil, err
			}
		}
	}

	resp := buildSdkMeta(config)
	resp["ok"] = true

	return &HandlerResponse{Status: 200, Body: resp}, nil
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func findScenario(config *HandlerConfig, name string) *ScenarioDefinition {
	for i := range config.Scenarios {
		if config.Scenarios[i].Name == name {
			return &config.Scenarios[i]
		}
	}
	return nil
}

// readScenarioName reads body.scenario.name from an untrusted JSON body.
func readScenarioName(body map[string]any) string {
	scenario, ok := body["scenario"].(map[string]any)
	if !ok {
		return ""
	}
	name, _ := scenario["name"].(string)
	return name
}
