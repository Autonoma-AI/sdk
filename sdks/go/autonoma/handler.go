package autonoma

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

//go:generate sh -c "printf 'package autonoma\n\n// Code generated from protocol/version.txt. DO NOT EDIT.\nconst ProtocolVersion = \"%s\"\n' \"$(cat ../../../protocol/version.txt | tr -d '\\n')\" > protocol_version_gen.go"

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
	if config.SharedSecret == config.SigningSecret {
		return nil, ErrSameSecrets()
	}

	if !config.AllowProduction {
		env := os.Getenv("GO_ENV")
		if env == "" {
			env = os.Getenv("APP_ENV")
		}
		if env == "" {
			env = os.Getenv("ENV")
		}
		if env == "production" {
			return nil, ErrProductionBlocked("Either GO_ENV, APP_ENV or ENV == 'production'. Set AllowProduction explicitly to change this.")
		}
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
		return nil, ErrInvalidBody("missing action. expected one of 'discover', 'up' or 'down'")
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
	factories := config.Factories
	if factories == nil {
		factories = FactoryRegistry{}
	}
	schema, err := BuildSchemaFromFactories(factories, config.ScopeField)
	if err != nil {
		return nil, err
	}

	resp := buildSdkMeta(config)
	resp["schema"] = SchemaToWire(schema)

	return &HandlerResponse{Status: 200, Body: resp}, nil
}

// ---------------------------------------------------------------------------
// up
// ---------------------------------------------------------------------------

func handleUp(config *HandlerConfig, body map[string]any) (*HandlerResponse, error) {
	createRaw, ok := body["create"]
	if !ok {
		return nil, ErrInvalidBody(`missing "create" in request body`)
	}

	create, ok := createRaw.(map[string]any)
	if !ok {
		return nil, ErrInvalidBody("`create` must be an object keyed by model name")
	}

	testRunID, _ := body["testRunId"].(string)
	if testRunID == "" {
		testRunID = uuid.New().String()
	}

	factories := config.Factories
	if factories == nil || len(factories) == 0 {
		return nil, ErrInvalidBody(
			"no factories registered -- every model in `create` must have a factory.")
	}

	tree, err := ResolvePayloadTree(create)
	if err != nil {
		return nil, err
	}

	refs := make(map[string][]map[string]any)
	idMap := make(map[string]any)

	// Track per-model run index for {{index}} / {{cycle()}} substitution.
	modelIndex := make(map[string]int)

	// Track model insertion order for deterministic teardown in Go.
	modelOrderSeen := make(map[string]bool)
	var modelOrder []string

	for _, op := range tree.Ops {
		model := op.Model
		factory, hasFactory := factories[model]
		if !hasFactory {
			return nil, ErrInvalidBody(fmt.Sprintf(
				`no factory registered for model "%s". Register one with DefineFactory(...) and add it to HandlerConfig.Factories.`,
				model))
		}

		idx := modelIndex[model]
		modelIndex[model] = idx + 1

		// Substitute built-in tokens then swap temp ids for real ids.
		resolved, err := ResolveTokens(op.Fields, testRunID, idx)
		if err != nil {
			return nil, err
		}
		resolvedFields := swapTempIDs(resolved, idMap)

		// Validate through the factory's InputStruct.
		fieldsMap, ok := resolvedFields.(map[string]any)
		if !ok {
			return nil, ErrInvalidBody(fmt.Sprintf("resolved fields for %q must be an object", model))
		}

		inputPtr := reflect.New(factory.InputStruct)
		fieldsJSON, err := json.Marshal(fieldsMap)
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal(fieldsJSON, inputPtr.Interface()); err != nil {
			return nil, ErrInvalidBody(fmt.Sprintf("validation failed for model %q: %s", model, err.Error()))
		}

		ctx := FactoryContext{
			Refs:         refs,
			ScenarioName: testRunID,
			TestRunID:    testRunID,
		}

		record, err := factory.Create(inputPtr.Interface(), ctx)
		if err != nil {
			return nil, err
		}

		if record == nil || record["id"] == nil {
			return nil, ErrFactoryMissingPK(model, "id")
		}

		if !modelOrderSeen[model] {
			modelOrderSeen[model] = true
			modelOrder = append(modelOrder, model)
		}
		refs[model] = append(refs[model], record)
		idMap[op.TempID] = record["id"]
	}

	// Auth callback gets the first User (case-insensitive on model name).
	firstUser := findFirstUser(refs)
	scopeValue := detectScopeValue(refs, config.ScopeField)
	if scopeValue == "" {
		scopeValue = testRunID
	}

	authCtx := AuthContext{ScopeValue: scopeValue, Refs: refs}
	auth := map[string]any{}
	if config.Auth != nil {
		auth, err = config.Auth(firstUser, authCtx)
		if err != nil {
			return nil, err
		}
	}

	if config.AfterUp != nil {
		hookCtx := HookContext{ScenarioName: scopeValue, Refs: refs}
		auth, err = config.AfterUp(hookCtx, auth)
		if err != nil {
			return nil, err
		}
	}

	refsToken, err := SignRefs(RefsPayload{
		Refs:              refs,
		TestRunID:         scopeValue,
		Environment:       "",
		AliasDependencies: tree.AliasDependencies,
		AliasOwnerModel:   tree.AliasOwnerModel,
		ModelOrder:        modelOrder,
	}, config.SigningSecret)
	if err != nil {
		return nil, err
	}

	resp := buildSdkMeta(config)
	resp["auth"] = auth
	resp["refs"] = refs
	resp["refsToken"] = refsToken

	return &HandlerResponse{Status: 200, Body: resp}, nil
}

// swapTempIDs replaces any __temp_* placeholder string with its real id.
func swapTempIDs(value any, idMap map[string]any) any {
	switch v := value.(type) {
	case string:
		if strings.HasPrefix(v, "__temp_") {
			if real, ok := idMap[v]; ok {
				return real
			}
		}
		return v
	case map[string]any:
		out := make(map[string]any, len(v))
		for k, child := range v {
			out[k] = swapTempIDs(child, idMap)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, child := range v {
			out[i] = swapTempIDs(child, idMap)
		}
		return out
	default:
		return value
	}
}

// ---------------------------------------------------------------------------
// down
// ---------------------------------------------------------------------------

func handleDown(config *HandlerConfig, body map[string]any) (*HandlerResponse, error) {
	refsToken, _ := body["refsToken"].(string)
	if refsToken == "" {
		return nil, ErrInvalidBody("missing refsToken")
	}

	payload, err := VerifyRefs(refsToken, config.SigningSecret)
	if err != nil {
		return nil, ErrInvalidRefsToken(err.Error())
	}

	refs := payload.Refs
	if refs == nil {
		refs = map[string][]map[string]any{}
	}
	testRunID := payload.TestRunID

	if config.BeforeDown != nil {
		hookCtx := HookContext{ScenarioName: testRunID, Refs: refs}
		if err := config.BeforeDown(hookCtx); err != nil {
			return nil, err
		}
	}

	factories := config.Factories
	if factories == nil {
		factories = FactoryRegistry{}
	}

	teardownOrder := ComputeTeardownOrder(refs, payload.AliasDependencies, payload.AliasOwnerModel, payload.ModelOrder)

	for _, model := range teardownOrder {
		factory, hasFactory := factories[model]
		if !hasFactory || factory.Teardown == nil {
			continue
		}
		records := refs[model]
		ctx := FactoryContext{
			Refs:         refs,
			ScenarioName: testRunID,
			TestRunID:    testRunID,
		}
		// Call teardown per record in reverse order.
		for j := len(records) - 1; j >= 0; j-- {
			record := records[j]
			var tdInput interface{} = record
			if factory.RefStruct != nil {
				refPtr := reflect.New(factory.RefStruct)
				recJSON, err := json.Marshal(record)
				if err != nil {
					return nil, err
				}
				if err := json.Unmarshal(recJSON, refPtr.Interface()); err != nil {
					return nil, err
				}
				tdInput = refPtr.Interface()
			}
			if err := factory.Teardown(tdInput, ctx); err != nil {
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

var (
	tokenRe = regexp.MustCompile(`\{\{\s*([^{}]+?)\s*\}\}`)
	cycleRe = regexp.MustCompile(`^cycle\((.*)\)$`)
)

// ResolveTokens substitutes built-in tokens in field values: {{testRunId}},
// {{index}}, {{cycle(a,b,c)}}. Returns an UNRESOLVED_TOKEN AutonomaError for
// any other {{token}}.
func ResolveTokens(value any, testRunID string, index int) (any, error) {
	switch v := value.(type) {
	case string:
		return resolveTokensString(v, testRunID, index)
	case []any:
		out := make([]any, len(v))
		for i, el := range v {
			resolved, err := ResolveTokens(el, testRunID, index)
			if err != nil {
				return nil, err
			}
			out[i] = resolved
		}
		return out, nil
	case map[string]any:
		out := make(map[string]any, len(v))
		for k, el := range v {
			resolved, err := ResolveTokens(el, testRunID, index)
			if err != nil {
				return nil, err
			}
			out[k] = resolved
		}
		return out, nil
	default:
		return value, nil
	}
}

func resolveTokensString(s, testRunID string, index int) (string, error) {
	var resolveErr error
	result := tokenRe.ReplaceAllStringFunc(s, func(match string) string {
		if resolveErr != nil {
			return ""
		}
		sub := tokenRe.FindStringSubmatch(match)
		token := strings.TrimSpace(sub[1])
		switch token {
		case "testRunId":
			return testRunID
		case "index":
			return strconv.Itoa(index)
		}
		if cm := cycleRe.FindStringSubmatch(token); cm != nil {
			rawParts := strings.Split(cm[1], ",")
			parts := make([]string, 0, len(rawParts))
			for _, p := range rawParts {
				t := strings.TrimSpace(p)
				if len(t) >= 2 {
					if (t[0] == '\'' && t[len(t)-1] == '\'') || (t[0] == '"' && t[len(t)-1] == '"') {
						t = t[1 : len(t)-1]
					}
				}
				parts = append(parts, t)
			}
			if len(parts) == 0 {
				return ""
			}
			idx := index % len(parts)
			if idx < 0 {
				idx += len(parts)
			}
			return parts[idx]
		}
		resolveErr = &AutonomaError{
			Message: fmt.Sprintf("Unresolved token: {{%s}}", token),
			Code:    "UNRESOLVED_TOKEN",
			Status:  400,
		}
		return ""
	})
	if resolveErr != nil {
		return "", resolveErr
	}
	return result, nil
}

func findFirstUser(refs map[string][]map[string]any) map[string]any {
	for model, records := range refs {
		normalized := strings.ToLower(model)
		if (normalized == "user" || normalized == "users") && len(records) > 0 {
			return records[0]
		}
	}
	return nil
}

func normalizeField(name string) string {
	return strings.ToLower(strings.ReplaceAll(name, "_", ""))
}

func detectScopeValue(refs map[string][]map[string]any, scopeField string) string {
	scopeNormalized := normalizeField(scopeField)
	for _, records := range refs {
		for _, record := range records {
			for key, value := range record {
				if normalizeField(key) == scopeNormalized {
					if s, ok := value.(string); ok {
						return s
					}
				}
			}
		}
	}
	return ""
}

// DefineFactory creates a validated FactoryDefinition.
func DefineFactory(
	create func(input interface{}, ctx FactoryContext) (map[string]any, error),
	inputStruct reflect.Type,
	teardown func(record interface{}, ctx FactoryContext) error,
	refStruct reflect.Type,
) FactoryDefinition {
	if create == nil {
		panic("Factory definition must include a non-nil create function")
	}
	if inputStruct == nil {
		panic("Factory must declare InputStruct. The SDK derives the discover schema from it.")
	}
	// Unwrap pointer to get struct type.
	t := inputStruct
	for t.Kind() == reflect.Ptr {
		t = t.Elem()
	}
	if t.Kind() != reflect.Struct {
		panic("Factory InputStruct must be a struct type (or pointer to struct)")
	}

	return FactoryDefinition{
		Create:      create,
		InputStruct: inputStruct,
		Teardown:    teardown,
		RefStruct:   refStruct,
	}
}
