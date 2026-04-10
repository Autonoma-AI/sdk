package autonoma

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

//go:generate sh -c "printf 'package autonoma\n\n// Code generated from protocol/version.txt. DO NOT EDIT.\nconst ProtocolVersion = \"%s\"\n' \"$(cat ../../../protocol/version.txt | tr -d '\\n')\" > protocol_version_gen.go"

var (
	introspectionCacheMu sync.Mutex
	introspectionCache   = make(map[*HandlerConfig]*IntrospectionResult)
)

func getIntrospection(ctx context.Context, config *HandlerConfig) (*IntrospectionResult, error) {
	introspectionCacheMu.Lock()
	cached, ok := introspectionCache[config]
	introspectionCacheMu.Unlock()
	if ok {
		return cached, nil
	}

	dialect, err := GetDialect(config.Dialect)
	if err != nil {
		return nil, err
	}

	result, err := IntrospectDatabase(ctx, config.Executor, dialect, introspectConfig{
		ScopeField:    config.ScopeField,
		Schema:        config.DBSchema,
		TableNameMap:  config.TableNameMap,
		ExcludeTables: config.ExcludeTables,
	})
	if err != nil {
		return nil, err
	}

	introspectionCacheMu.Lock()
	introspectionCache[config] = result
	introspectionCacheMu.Unlock()

	return result, nil
}

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
func HandleRequest(ctx context.Context, config *HandlerConfig, req HandlerRequest) HandlerResponse {
	resp, err := handleRequestInner(ctx, config, req)
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

func handleRequestInner(ctx context.Context, config *HandlerConfig, req HandlerRequest) (*HandlerResponse, error) {
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
			return nil, ErrProductionBlocked()
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
		return nil, ErrInvalidBody("missing action")
	}

	switch action {
	case "discover":
		return handleDiscover(ctx, config)
	case "up":
		return handleUp(ctx, config, body)
	case "down":
		return handleDown(ctx, config, body)
	default:
		return nil, ErrUnknownAction(action)
	}
}

func handleDiscover(ctx context.Context, config *HandlerConfig) (*HandlerResponse, error) {
	introspection, err := getIntrospection(ctx, config)
	if err != nil {
		return nil, err
	}

	schemaJSON := schemaToJSON(introspection.Schema)
	resp := buildSdkMeta(config)
	resp["schema"] = schemaJSON

	return &HandlerResponse{Status: 200, Body: resp}, nil
}

func handleUp(ctx context.Context, config *HandlerConfig, body map[string]any) (*HandlerResponse, error) {
	createRaw, ok := body["create"]
	if !ok {
		return nil, ErrInvalidBody(`missing "create" in request body`)
	}

	create, err := normalizeCreate(createRaw)
	if err != nil {
		return nil, ErrInvalidBody("invalid create format")
	}

	testRunID, _ := body["testRunId"].(string)
	if testRunID == "" {
		testRunID = uuid.New().String()
	}

	introspection, err := getIntrospection(ctx, config)
	if err != nil {
		return nil, err
	}
	schema := introspection.Schema

	dialect, err := GetDialect(config.Dialect)
	if err != nil {
		return nil, err
	}

	tree := ResolveTree(create, schema)
	refs := make(map[string][]map[string]any)
	idMap := make(map[string]any)

	err = config.Executor.Transaction(ctx, func(tx SQLExecutor) error {
		i := 0
		for i < len(tree.Ops) {
			op := tree.Ops[i]
			model := op.Model

			// Collect consecutive ops for the same model
			batch := []CreateOp{op}
			for i+1 < len(tree.Ops) && tree.Ops[i+1].Model == model {
				i++
				batch = append(batch, tree.Ops[i])
			}

			// Find model info for auto-populating fields
			var modelInfo *ModelInfo
			for idx := range schema.Models {
				if schema.Models[idx].Name == model {
					modelInfo = &schema.Models[idx]
					break
				}
			}

			// Bug 4: find actual PK field name from schema
			// When multiple IsId fields exist (composite PK), prefer the one named "id"
			pkFieldName := "id"
			for _, mi := range schema.Models {
				if mi.Name == model {
					var firstId string
					for _, f := range mi.Fields {
						if f.IsId {
							if firstId == "" {
								firstId = f.Name
							}
							if strings.EqualFold(f.Name, "id") {
								pkFieldName = f.Name
								firstId = "" // signal we found "id"
								break
							}
						}
					}
					if firstId != "" {
						pkFieldName = firstId
					}
					break
				}
			}

			resolvedFields := make([]map[string]any, len(batch))
			for j, b := range batch {
				fields := make(map[string]any, len(b.Fields))
				for k, v := range b.Fields {
					fields[k] = v
				}

				// Replace temp IDs with real IDs
				for key, value := range fields {
					if s, ok := value.(string); ok && strings.HasPrefix(s, "__temp_") {
						if realID, found := idMap[s]; found {
							fields[key] = realID
						}
					}
				}

				// Inject scope field if applicable
				for _, edge := range schema.Edges {
					if edge.From == model && normalizeField(edge.LocalField) == normalizeField(schema.ScopeField) && edge.From != edge.To {
						if _, exists := fields[edge.LocalField]; !exists {
							scopeVal := detectScopeValue(refs, schema.ScopeField)
							if scopeVal != "" {
								fields[edge.LocalField] = scopeVal
							}
						}
						break
					}
				}

				// Auto-populate required DateTime fields without defaults
				if modelInfo != nil {
					for _, field := range modelInfo.Fields {
						if field.IsRequired && !field.HasDefault && !field.IsId {
							if _, exists := fields[field.Name]; !exists {
								if field.Type == "DateTime" {
									fields[field.Name] = time.Now().UTC()
								}
							}
						}
					}
				}

				resolvedFields[j] = fields
			}

			spec := map[string]ResolvedEntitySpec{
				model: {Count: len(resolvedFields), Fields: resolvedFields},
			}

			created, err := CreateEntities(ctx, tx, dialect, introspection.TableMap, introspection.ColumnMaps, spec, introspection.EnumTypeMaps, schema.Models)
			if err != nil {
				return err
			}

			records := created[model]
			if refs[model] == nil {
				refs[model] = nil
			}
			refs[model] = append(refs[model], records...)

			// Bug 3: accept any non-nil value for idMap, not just strings
			for j, b := range batch {
				if j < len(records) {
					record := records[j]
					if id := record[pkFieldName]; id != nil {
						idMap[b.TempID] = id
					}
				}
			}

			i++
		}

		// Resolve deferred FK updates
		for _, deferred := range tree.DeferredUpdates {
			realTargetID := idMap[deferred.TargetTempID]
			refTempID, aliasExists := tree.Aliases[deferred.RefAlias]
			var realRefID any
			if aliasExists {
				realRefID = idMap[refTempID]
			}

			if realTargetID == nil || realRefID == nil {
				return fmt.Errorf(`_ref "%s" could not be resolved. Ensure the referenced node has _alias defined in the scenario`, deferred.RefAlias)
			}

			// Bug 4: find PK field name for deferred model
			// When multiple IsId fields exist (composite PK), prefer the one named "id"
			deferredPkFieldName := "id"
			for _, mi := range schema.Models {
				if mi.Name == deferred.Model {
					var firstId string
					for _, f := range mi.Fields {
						if f.IsId {
							if firstId == "" {
								firstId = f.Name
							}
							if strings.EqualFold(f.Name, "id") {
								deferredPkFieldName = f.Name
								firstId = ""
								break
							}
						}
					}
					if firstId != "" {
						deferredPkFieldName = firstId
					}
					break
				}
			}

			err := UpdateEntity(ctx, tx, dialect, introspection.TableMap, introspection.ColumnMaps,
				deferred.Model, fmt.Sprintf("%v", realTargetID), map[string]any{deferred.Field: realRefID}, introspection.EnumTypeMaps, deferredPkFieldName)
			if err != nil {
				return err
			}
		}

		return nil
	})
	if err != nil {
		return nil, err
	}

	scopeValue := detectScopeValue(refs, schema.ScopeField)
	if scopeValue == "" {
		scopeValue = testRunID
	}

	firstUser := findFirstUser(refs)
	auth := map[string]any{"token": ""}
	if config.Auth != nil && firstUser != nil {
		authResult, err := config.Auth(firstUser)
		if err != nil {
			return nil, err
		}
		auth = map[string]any{"token": authResult.Token}
		for k, v := range authResult.Extra {
			auth[k] = v
		}
	}

	refsToken, err := SignRefs(RefsPayload{
		Refs:        refs,
		TestRunID:   scopeValue,
		Environment: "",
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

func handleDown(ctx context.Context, config *HandlerConfig, body map[string]any) (*HandlerResponse, error) {
	refsToken, _ := body["refsToken"].(string)
	if refsToken == "" {
		return nil, ErrInvalidBody("missing refsToken")
	}

	payload, err := VerifyRefs(refsToken, config.SigningSecret)
	if err != nil {
		return nil, ErrInvalidRefsToken(err.Error())
	}

	introspection, err := getIntrospection(ctx, config)
	if err != nil {
		return nil, err
	}

	dialect, err := GetDialect(config.Dialect)
	if err != nil {
		return nil, err
	}

	err = Teardown(ctx, config.Executor, dialect, introspection.TableMap, introspection.ColumnMaps,
		introspection.Schema, payload.TestRunID, payload.Refs)
	if err != nil {
		return nil, err
	}

	resp := buildSdkMeta(config)
	resp["ok"] = true

	return &HandlerResponse{Status: 200, Body: resp}, nil
}

// Bug 8: match both "user" and "users" (case-insensitive)
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

// normalizeCreate converts the raw JSON "create" value into the typed Go map.
func normalizeCreate(raw any) (map[string][]map[string]any, error) {
	m, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("create must be an object")
	}

	result := make(map[string][]map[string]any, len(m))
	for model, v := range m {
		arr, ok := v.([]any)
		if !ok {
			return nil, fmt.Errorf("create.%s must be an array", model)
		}
		nodes := make([]map[string]any, len(arr))
		for i, item := range arr {
			node, ok := item.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("create.%s[%d] must be an object", model, i)
			}
			nodes[i] = node
		}
		result[model] = nodes
	}
	return result, nil
}

// schemaToJSON converts SchemaInfo to a JSON-friendly map.
func schemaToJSON(schema SchemaInfo) map[string]any {
	models := make([]map[string]any, len(schema.Models))
	for i, m := range schema.Models {
		fields := make([]map[string]any, len(m.Fields))
		for j, f := range m.Fields {
			fields[j] = map[string]any{
				"name":       f.Name,
				"type":       f.Type,
				"isRequired": f.IsRequired,
				"isId":       f.IsId,
				"hasDefault": f.HasDefault,
			}
		}
		models[i] = map[string]any{
			"name":      m.Name,
			"tableName": m.TableName,
			"fields":    fields,
		}
	}

	edges := make([]map[string]any, len(schema.Edges))
	for i, e := range schema.Edges {
		edges[i] = map[string]any{
			"from":         e.From,
			"to":           e.To,
			"localField":   e.LocalField,
			"foreignField": e.ForeignField,
			"nullable":     e.Nullable,
		}
	}

	relations := make([]map[string]any, len(schema.Relations))
	for i, r := range schema.Relations {
		relations[i] = map[string]any{
			"parentModel": r.ParentModel,
			"childModel":  r.ChildModel,
			"parentField": r.ParentField,
			"childField":  r.ChildField,
		}
	}

	return map[string]any{
		"models":     models,
		"edges":      edges,
		"relations":  relations,
		"scopeField": schema.ScopeField,
	}
}
