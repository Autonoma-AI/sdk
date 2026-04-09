package autonoma

import (
	"strings"
	"testing"
)

func TestSignRefs(t *testing.T) {
	payload := RefsPayload{
		Refs:        map[string][]map[string]any{"User": {{"id": "user-1", "email": "test@test.com"}}},
		TestRunID:   "test-run-123",
		Environment: "standard",
	}

	token, err := SignRefs(payload, "signing-secret")
	if err != nil {
		t.Fatalf("SignRefs() error: %v", err)
	}

	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Errorf("Expected 3 parts, got %d", len(parts))
	}
}

func TestVerifyRefs(t *testing.T) {
	t.Run("round-trips signed token", func(t *testing.T) {
		payload := RefsPayload{
			Refs:        map[string][]map[string]any{"User": {{"id": "user-1", "email": "test@test.com"}}},
			TestRunID:   "test-run-123",
			Environment: "standard",
		}
		secret := "signing-secret"

		token, err := SignRefs(payload, secret)
		if err != nil {
			t.Fatalf("SignRefs() error: %v", err)
		}

		result, err := VerifyRefs(token, secret)
		if err != nil {
			t.Fatalf("VerifyRefs() error: %v", err)
		}

		if result.TestRunID != "test-run-123" {
			t.Errorf("TestRunID = %q, want %q", result.TestRunID, "test-run-123")
		}
		if result.Environment != "standard" {
			t.Errorf("Environment = %q, want %q", result.Environment, "standard")
		}
	})

	t.Run("rejects wrong secret", func(t *testing.T) {
		token := "eyJhbGciOiJIUzI1NiIsInR5cCI6IlJFRlMifQ.eyJyZWZzIjp7IlVzZXIiOlt7ImlkIjoidXNlci0xIiwiZW1haWwiOiJ0ZXN0QHRlc3QuY29tIn1dfSwidGVzdFJ1bklkIjoidGVzdC1ydW4tMTIzIiwiZW52aXJvbm1lbnQiOiJzdGFuZGFyZCJ9.b2340UY6iXALRK2SaBV0BzZLVbxC8J59_csCUEc-gOw"
		_, err := VerifyRefs(token, "wrong-secret")
		if err == nil {
			t.Error("Expected error for wrong secret")
		}
	})

	t.Run("rejects malformed token", func(t *testing.T) {
		_, err := VerifyRefs("only-one-part", "signing-secret")
		if err == nil {
			t.Error("Expected error for malformed token")
		}
	})

	t.Run("rejects tampered payload", func(t *testing.T) {
		token := "eyJhbGciOiJIUzI1NiIsInR5cCI6IlJFRlMifQ.dGFtcGVyZWQ.b2340UY6iXALRK2SaBV0BzZLVbxC8J59_csCUEc-gOw"
		_, err := VerifyRefs(token, "signing-secret")
		if err == nil {
			t.Error("Expected error for tampered payload")
		}
	})
}
