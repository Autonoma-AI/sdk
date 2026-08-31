package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/autonoma-ai/sdk/sdks/go/v2/autonoma"
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
	case "hmac.signBody":
		body, _ := input.Input["body"].(string)
		secret, _ := input.Input["secret"].(string)
		writeResult(autonoma.SignBody(body, secret))

	case "hmac.verifySignature":
		body, _ := input.Input["body"].(string)
		signature, _ := input.Input["signature"].(string)
		secret, _ := input.Input["secret"].(string)
		writeResult(autonoma.VerifySignature(body, signature, secret))

	case "refs.signRefs":
		secret, _ := input.Input["secret"].(string)
		result, err := autonoma.SignRefs(toRefsPayload(input.Input["payload"]), secret)
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
		writeResult(map[string]any{
			"refs":        result.Refs,
			"testRunId":   result.TestRunID,
			"environment": result.Environment,
		})

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

func toRefsPayload(v any) autonoma.RefsPayload {
	m, ok := v.(map[string]any)
	if !ok {
		return autonoma.RefsPayload{}
	}
	testRunID, _ := m["testRunId"].(string)
	environment, _ := m["environment"].(string)
	return autonoma.RefsPayload{
		Refs:        m["refs"],
		TestRunID:   testRunID,
		Environment: environment,
	}
}
