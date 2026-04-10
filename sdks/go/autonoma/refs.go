package autonoma

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// SignRefs signs a refs payload into a JWT-like token (header.payload.signature).
func SignRefs(payload RefsPayload, secret string) (string, error) {
	headerJSON, err := json.Marshal(map[string]string{"alg": "HS256", "typ": "REFS"})
	if err != nil {
		return "", err
	}

	// Bug 7: pre-process refs to convert time.Time, uuid.UUID, etc. to JSON-safe strings
	sanitizedRefs := sanitizeRefs(payload.Refs)
	sanitizedPayload := map[string]any{
		"refs":        sanitizedRefs,
		"testRunId":   payload.TestRunID,
		"environment": payload.Environment,
	}

	payloadJSON, err := json.Marshal(sanitizedPayload)
	if err != nil {
		return "", err
	}

	header := base64.RawURLEncoding.EncodeToString(headerJSON)
	body := base64.RawURLEncoding.EncodeToString(payloadJSON)
	sig := hmacBase64URL(header+"."+body, secret)

	return header + "." + body + "." + sig, nil
}

// VerifyRefs verifies and decodes a refs token. Returns the payload or an error.
func VerifyRefs(token string, secret string) (*RefsPayload, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errors.New("malformed token")
	}

	header := parts[0]
	body := parts[1]
	signature := parts[2]

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

// sanitizeRefs converts non-JSON-safe types (time.Time, uuid.UUID, etc.) to strings
// so that JSON marshaling produces deterministic, portable output.
func sanitizeRefs(refs map[string][]map[string]any) map[string][]map[string]any {
	result := make(map[string][]map[string]any, len(refs))
	for model, records := range refs {
		sanitizedRecords := make([]map[string]any, len(records))
		for i, record := range records {
			sanitizedRecords[i] = sanitizeRecord(record)
		}
		result[model] = sanitizedRecords
	}
	return result
}

func sanitizeRecord(record map[string]any) map[string]any {
	result := make(map[string]any, len(record))
	for key, value := range record {
		result[key] = sanitizeValue(value)
	}
	return result
}

func sanitizeValue(value any) any {
	if value == nil {
		return nil
	}
	switch v := value.(type) {
	case time.Time:
		return v.Format(time.RFC3339Nano)
	case map[string]any:
		return sanitizeRecord(v)
	case []any:
		sanitized := make([]any, len(v))
		for i, item := range v {
			sanitized[i] = sanitizeValue(item)
		}
		return sanitized
	default:
		// For types that implement fmt.Stringer (like uuid.UUID), convert to string
		if stringer, ok := value.(fmt.Stringer); ok {
			return stringer.String()
		}
		return value
	}
}
