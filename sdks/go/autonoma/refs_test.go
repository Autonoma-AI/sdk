package autonoma

import (
	"strings"
	"testing"
)

func TestSignRefs_ThreeParts(t *testing.T) {
	payload := RefsPayload{
		Refs:        map[string]any{"userId": "user-1", "email": "test@test.com"},
		TestRunID:   "test-run-123",
		Environment: "standard",
	}
	token, err := SignRefs(payload, "signing-secret")
	if err != nil {
		t.Fatalf("SignRefs() error: %v", err)
	}
	if parts := strings.Split(token, "."); len(parts) != 3 {
		t.Errorf("expected 3 parts, got %d", len(parts))
	}
}

func TestVerifyRefs_RoundTrip(t *testing.T) {
	payload := RefsPayload{
		Refs:        map[string]any{"userId": "user-1", "nested": map[string]any{"count": float64(3)}},
		TestRunID:   "test-run-123",
		Environment: "standard",
	}
	secret := "signing-secret"

	token, err := SignRefs(payload, secret)
	if err != nil {
		t.Fatalf("SignRefs() error: %v", err)
	}
	got, err := VerifyRefs(token, secret)
	if err != nil {
		t.Fatalf("VerifyRefs() error: %v", err)
	}

	if got.TestRunID != "test-run-123" {
		t.Errorf("TestRunID = %q, want test-run-123", got.TestRunID)
	}
	if got.Environment != "standard" {
		t.Errorf("Environment = %q, want standard", got.Environment)
	}
	refs, ok := got.Refs.(map[string]any)
	if !ok {
		t.Fatalf("expected refs to decode as an object, got %T", got.Refs)
	}
	if refs["userId"] != "user-1" {
		t.Errorf("refs.userId = %v, want user-1", refs["userId"])
	}
	nested, ok := refs["nested"].(map[string]any)
	if !ok || nested["count"] != float64(3) {
		t.Errorf("expected nested arbitrary JSON to round-trip, got %v", refs["nested"])
	}
}

func TestVerifyRefs_RejectsWrongSecret(t *testing.T) {
	payload := RefsPayload{Refs: map[string]any{}, TestRunID: "r", Environment: "e"}
	token, _ := SignRefs(payload, "right-secret")
	if _, err := VerifyRefs(token, "wrong-secret"); err == nil {
		t.Error("expected error for wrong secret")
	}
}

func TestVerifyRefs_RejectsMalformed(t *testing.T) {
	if _, err := VerifyRefs("only-one-part", "signing-secret"); err == nil {
		t.Error("expected error for malformed token")
	}
}

func TestVerifyRefs_RejectsTampered(t *testing.T) {
	payload := RefsPayload{Refs: map[string]any{"a": "b"}, TestRunID: "r", Environment: "e"}
	token, _ := SignRefs(payload, "signing-secret")
	parts := strings.Split(token, ".")
	tampered := parts[0] + ".dGFtcGVyZWQ." + parts[2] // swap the payload segment
	if _, err := VerifyRefs(tampered, "signing-secret"); err == nil {
		t.Error("expected error for tampered payload")
	}
}
