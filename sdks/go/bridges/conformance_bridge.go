package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/autonoma-ai/sdk-go/autonoma"
)

type bridgeInput struct {
	Module   string         `json:"module"`
	Function string         `json:"function"`
	Input    map[string]any `json:"input"`
}

type bridgeOutput struct {
	OK        bool   `json:"ok"`
	Result    any    `json:"result"`
	HasResult bool   `json:"-"`
	Error     string `json:"error,omitempty"`
}

func (b bridgeOutput) MarshalJSON() ([]byte, error) {
	if !b.OK {
		return json.Marshal(struct {
			OK    bool   `json:"ok"`
			Error string `json:"error,omitempty"`
		}{OK: false, Error: b.Error})
	}
	return json.Marshal(struct {
		OK     bool `json:"ok"`
		Result any  `json:"result"`
	}{OK: true, Result: b.Result})
}

func main() {
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		writeError(fmt.Sprintf("failed to read stdin: %v", err))
		return
	}

	var input bridgeInput
	if err := json.Unmarshal(data, &input); err != nil {
		writeError(fmt.Sprintf("failed to parse input: %v", err))
		return
	}

	dispatch(input)
}

func dispatch(input bridgeInput) {
	key := input.Module + "." + input.Function

	defer func() {
		if r := recover(); r != nil {
			writeError(fmt.Sprintf("%v", r))
		}
	}()

	switch key {
	case "graph.topoSort":
		nodes := toStringSlice(input.Input["nodes"])
		edges := toFKEdges(input.Input["edges"])
		result := autonoma.TopoSort(nodes, edges)
		writeResult(result)

	case "graph.findDeferrableEdge":
		cycle := toStringSlice(input.Input["cycle"])
		edges := toFKEdges(input.Input["edges"])
		edge := autonoma.FindDeferrableEdge(cycle, edges)
		writeResult(edge)

	case "hmac.signBody":
		body, _ := input.Input["body"].(string)
		secret, _ := input.Input["secret"].(string)
		result := autonoma.SignBody(body, secret)
		writeResult(result)

	case "hmac.verifySignature":
		body, _ := input.Input["body"].(string)
		signature, _ := input.Input["signature"].(string)
		secret, _ := input.Input["secret"].(string)
		result := autonoma.VerifySignature(body, signature, secret)
		writeResult(result)

	case "refs.signRefs":
		payloadRaw := input.Input["payload"]
		secret, _ := input.Input["secret"].(string)
		payload := toRefsPayload(payloadRaw)
		result, err := autonoma.SignRefs(payload, secret)
		if err != nil {
			writeError(err.Error())
			return
		}
		writeResult(result)

	case "refs.verifyRefs":
		token, _ := input.Input["token"].(string)
		secret, _ := input.Input["secret"].(string)
		result, err := autonoma.VerifyRefs(token, secret)
		if err != nil {
			writeError(err.Error())
			return
		}
		// Convert to the expected JSON format
		writeResult(map[string]any{
			"refs":        result.Refs,
			"testRunId":   result.TestRunID,
			"environment": result.Environment,
		})

	case "fingerprint.fingerprint":
		value := input.Input["value"]
		result := autonoma.Fingerprint(value)
		writeResult(result)

	default:
		writeError(fmt.Sprintf("Unknown function: %s", key))
	}
}

func writeResult(result any) {
	out := bridgeOutput{OK: true, Result: result, HasResult: true}
	data, _ := json.Marshal(out)
	fmt.Println(string(data))
}

func writeError(msg string) {
	out := bridgeOutput{OK: false, Error: msg}
	data, _ := json.Marshal(out)
	fmt.Println(string(data))
}

func toStringSlice(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	result := make([]string, len(arr))
	for i, item := range arr {
		result[i], _ = item.(string)
	}
	return result
}

func toFKEdges(v any) []autonoma.FKEdge {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	edges := make([]autonoma.FKEdge, len(arr))
	for i, item := range arr {
		m, _ := item.(map[string]any)
		edges[i] = autonoma.FKEdge{
			From:         getString(m, "from"),
			To:           getString(m, "to"),
			LocalField:   getString(m, "localField"),
			ForeignField: getString(m, "foreignField"),
			Nullable:     getBool(m, "nullable"),
		}
	}
	return edges
}

func toRefsPayload(v any) autonoma.RefsPayload {
	m, ok := v.(map[string]any)
	if !ok {
		return autonoma.RefsPayload{}
	}

	refs := make(map[string][]map[string]any)
	if refsRaw, ok := m["refs"].(map[string]any); ok {
		for model, records := range refsRaw {
			if arr, ok := records.([]any); ok {
				var items []map[string]any
				for _, item := range arr {
					if record, ok := item.(map[string]any); ok {
						items = append(items, record)
					}
				}
				refs[model] = items
			}
		}
	}

	testRunID, _ := m["testRunId"].(string)
	environment, _ := m["environment"].(string)

	return autonoma.RefsPayload{
		Refs:        refs,
		TestRunID:   testRunID,
		Environment: environment,
	}
}

func getString(m map[string]any, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func getBool(m map[string]any, key string) bool {
	if v, ok := m[key].(bool); ok {
		return v
	}
	return false
}
