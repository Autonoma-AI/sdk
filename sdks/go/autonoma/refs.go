package autonoma

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
)

// SignRefs signs a refs payload into a JWT-like token (header.payload.signature).
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
	if expected != signature {
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
