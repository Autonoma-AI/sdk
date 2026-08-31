package autonoma

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
)

// RefsPayload is the payload signed into the teardown token.
type RefsPayload struct {
	// Refs is whatever a scenario's Up returned as refs - arbitrary JSON, signed
	// at Up and handed back to Down verbatim.
	Refs any `json:"refs"`
	// TestRunID is the testRunId captured at Up time.
	TestRunID string `json:"testRunId"`
	// Environment is the scenario name. Named "environment" for wire/back-compat
	// reasons; Down reads it to route to the right scenario's teardown.
	Environment string `json:"environment"`
}

// SignRefs signs a refs payload into a JWT-like token (header.payload.signature)
// using HMAC-SHA256.
func SignRefs(payload RefsPayload, secret string) (string, error) {
	headerJSON, err := json.Marshal(map[string]string{"alg": "HS256", "typ": "REFS"})
	if err != nil {
		return "", err
	}
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}

	header := base64.RawURLEncoding.EncodeToString(headerJSON)
	body := base64.RawURLEncoding.EncodeToString(payloadJSON)
	sig := hmacBase64URL(header+"."+body, secret)

	return header + "." + body + "." + sig, nil
}

// VerifyRefs verifies and decodes a teardown token, returning the payload or an error.
func VerifyRefs(token string, secret string) (*RefsPayload, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errors.New("malformed token")
	}

	header, body, signature := parts[0], parts[1], parts[2]
	expected := hmacBase64URL(header+"."+body, secret)
	if subtle.ConstantTimeCompare([]byte(expected), []byte(signature)) != 1 {
		return nil, errors.New("signature mismatch")
	}

	payloadBytes, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil {
		return nil, err
	}

	var payload RefsPayload
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return nil, err
	}

	return &payload, nil
}

func hmacBase64URL(data string, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(data))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
