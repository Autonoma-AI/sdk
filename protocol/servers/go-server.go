// Minimal net/http server that runs the Go SDK's v2 handler with a couple of
// scenarios. Used by run-suites.mjs to exercise the shared protocol/suites/*
// against a real Go endpoint. It mirrors protocol/servers/ts-server.ts.
package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/autonoma-ai/sdk/sdks/go/v2/autonoma"
)

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	sharedSecret := getenv("AUTONOMA_SHARED_SECRET", "protocol-shared")
	signingSecret := getenv("AUTONOMA_SIGNING_SECRET", "protocol-signing")
	port := getenv("PORT", "4597")

	config := &autonoma.HandlerConfig{
		SharedSecret:  sharedSecret,
		SigningSecret: signingSecret,
		SDK:           &autonoma.SdkInfo{Orm: "none", Server: "net/http"},
		Scenarios: []autonoma.ScenarioDefinition{
			autonoma.DefineScenario(autonoma.ScenarioDefinition{
				Name:        "standard",
				Description: "A standard seeded environment",
				Up: func(ctx autonoma.ScenarioUpContext) (autonoma.ScenarioUpResult, error) {
					return autonoma.ScenarioUpResult{
						Auth: &autonoma.AuthResult{
							Headers: map[string]string{"Authorization": "Bearer token-" + ctx.TestRunID},
						},
						Teardown: map[string]any{"userId": "user-" + ctx.TestRunID},
					}, nil
				},
				Down: func(ctx autonoma.ScenarioDownContext) error { return nil },
			}),
			autonoma.DefineScenario(autonoma.ScenarioDefinition{
				Name:        "empty",
				Description: "Nothing seeded",
				Up: func(ctx autonoma.ScenarioUpContext) (autonoma.ScenarioUpResult, error) {
					return autonoma.ScenarioUpResult{}, nil
				},
			}),
		},
	}

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		bodyBytes, err := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "failed to read request body", "code": "INTERNAL_ERROR"})
			return
		}

		headers := make(map[string]string, len(r.Header))
		for key, vals := range r.Header {
			if len(vals) > 0 {
				headers[strings.ToLower(key)] = vals[0]
			}
		}

		result := autonoma.HandleRequest(config, autonoma.HandlerRequest{Body: string(bodyBytes), Headers: headers})
		w.WriteHeader(result.Status)
		_ = json.NewEncoder(w).Encode(result.Body)
	})

	log.Printf("go-server listening on %s", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatal(err)
	}
}
