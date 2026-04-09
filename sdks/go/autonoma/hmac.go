package autonoma

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
)

// SignBody computes the HMAC-SHA256 of body using secret, returned as lowercase hex.
func SignBody(body string, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(body))
	return hex.EncodeToString(mac.Sum(nil))
}

// VerifySignature checks that signature matches the HMAC-SHA256 of body with secret.
// Uses constant-time comparison.
func VerifySignature(body string, signature string, secret string) bool {
	expected := SignBody(body, secret)
	if len(expected) != len(signature) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(signature)) == 1
}
