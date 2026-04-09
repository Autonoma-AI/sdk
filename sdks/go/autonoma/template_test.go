package autonoma

import (
	"strings"
	"testing"
)

func TestResolveTemplate(t *testing.T) {
	t.Run("resolves testRunId", func(t *testing.T) {
		result := ResolveTemplate("{{testRunId}}", TemplateContext{TestRunID: "run-abc123", Index: 0})
		if result != "run-abc123" {
			t.Errorf("got %v, want run-abc123", result)
		}
	})

	t.Run("resolves index preserving number type", func(t *testing.T) {
		result := ResolveTemplate("{{index}}", TemplateContext{TestRunID: "x", Index: 2})
		if result != float64(2) {
			t.Errorf("got %v (%T), want 2 (float64)", result, result)
		}
	})

	t.Run("resolves index1 (1-based)", func(t *testing.T) {
		result := ResolveTemplate("{{index1}}", TemplateContext{TestRunID: "x", Index: 2})
		if result != float64(3) {
			t.Errorf("got %v, want 3", result)
		}
	})

	t.Run("interpolates in strings", func(t *testing.T) {
		result := ResolveTemplate("admin-{{testRunId}}@autonoma.dev", TemplateContext{TestRunID: "run-abc123", Index: 0})
		if result != "admin-run-abc123@autonoma.dev" {
			t.Errorf("got %v, want admin-run-abc123@autonoma.dev", result)
		}
	})

	t.Run("cycle", func(t *testing.T) {
		result := ResolveTemplate("{{cycle(['active','inactive','draft'])}}", TemplateContext{TestRunID: "x", Index: 0})
		if result != "active" {
			t.Errorf("got %v, want active", result)
		}

		result = ResolveTemplate("{{cycle(['active','inactive','draft'])}}", TemplateContext{TestRunID: "x", Index: 4})
		if result != "inactive" {
			t.Errorf("got %v, want inactive", result)
		}
	})

	t.Run("passthrough non-template strings", func(t *testing.T) {
		result := ResolveTemplate("plain string", TemplateContext{TestRunID: "x", Index: 0})
		if result != "plain string" {
			t.Errorf("got %v, want 'plain string'", result)
		}
	})

	t.Run("passthrough numbers", func(t *testing.T) {
		result := ResolveTemplate(float64(42), TemplateContext{TestRunID: "x", Index: 0})
		if result != float64(42) {
			t.Errorf("got %v, want 42", result)
		}
	})

	t.Run("passthrough booleans", func(t *testing.T) {
		result := ResolveTemplate(true, TemplateContext{TestRunID: "x", Index: 0})
		if result != true {
			t.Errorf("got %v, want true", result)
		}
	})

	t.Run("passthrough null", func(t *testing.T) {
		result := ResolveTemplate(nil, TemplateContext{TestRunID: "x", Index: 0})
		if result != nil {
			t.Errorf("got %v, want nil", result)
		}
	})

	t.Run("now() returns ISO string", func(t *testing.T) {
		result := ResolveTemplate("{{now()}}", TemplateContext{TestRunID: "x", Index: 0})
		s, ok := result.(string)
		if !ok {
			t.Fatalf("expected string, got %T", result)
		}
		if !strings.Contains(s, "T") {
			t.Errorf("expected ISO string, got %s", s)
		}
	})

	t.Run("random.int in range", func(t *testing.T) {
		result := ResolveTemplate("{{random.int(1,100)}}", TemplateContext{TestRunID: "x", Index: 0})
		n, ok := result.(float64)
		if !ok {
			t.Fatalf("expected float64, got %T", result)
		}
		if n < 1 || n > 100 {
			t.Errorf("expected 1-100, got %v", n)
		}
	})

	t.Run("resolves nested objects", func(t *testing.T) {
		input := map[string]any{"name": "User {{index1}}", "runId": "{{testRunId}}"}
		result := ResolveTemplate(input, TemplateContext{TestRunID: "run-abc123", Index: 2})
		m, ok := result.(map[string]any)
		if !ok {
			t.Fatalf("expected map, got %T", result)
		}
		if m["name"] != "User 3" {
			t.Errorf("name = %v, want 'User 3'", m["name"])
		}
		if m["runId"] != "run-abc123" {
			t.Errorf("runId = %v, want 'run-abc123'", m["runId"])
		}
	})
}
