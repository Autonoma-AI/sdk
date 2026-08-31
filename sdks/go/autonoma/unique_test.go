package autonoma

import (
	"regexp"
	"testing"
)

// These vectors are cross-checked against the TypeScript unique.ts recipe so
// the same (testRunId, ...parts) yields byte-identical output across languages.
func TestUnique_CrossLanguageVectors(t *testing.T) {
	if got := UniqueToken("run-1"); got != "4e65d3fbe8ad" {
		t.Errorf("UniqueToken(run-1) = %q, want 4e65d3fbe8ad", got)
	}
	if got := UniqueEmail("run-1", "", ""); got != "user+039af36014b8@example.com" {
		t.Errorf("UniqueEmail(run-1) = %q, want user+039af36014b8@example.com", got)
	}
	if got := UniqueSlug("run-1", "Acme"); got != "acme-b6446df155f8" {
		t.Errorf("UniqueSlug(run-1,Acme) = %q, want acme-b6446df155f8", got)
	}
	if got := UniqueID("run-1", "user"); got != "user_776b5cbfd0f0" {
		t.Errorf("UniqueID(run-1,user) = %q, want user_776b5cbfd0f0", got)
	}
}

func TestUnique_TokenShape(t *testing.T) {
	token := UniqueToken("run", "a", "b")
	if len(token) != 12 {
		t.Errorf("token length = %d, want 12", len(token))
	}
	if !regexp.MustCompile(`^[0-9a-f]{12}$`).MatchString(token) {
		t.Errorf("token %q is not 12 lowercase hex chars", token)
	}
}

func TestUnique_DeterministicAndSeeded(t *testing.T) {
	// Same inputs, same output.
	if UniqueToken("run", "x") != UniqueToken("run", "x") {
		t.Error("UniqueToken is not deterministic")
	}
	// Different testRunId, different output.
	if UniqueToken("run-a", "x") == UniqueToken("run-b", "x") {
		t.Error("UniqueToken must differ across testRunIds")
	}
	// Different parts, different output.
	if UniqueToken("run", "x") == UniqueToken("run", "y") {
		t.Error("UniqueToken must differ across parts")
	}
}

func TestUnique_SlugNormalization(t *testing.T) {
	slug := UniqueSlug("run", "Acme Corp!!")
	if !regexp.MustCompile(`^acme-corp-[0-9a-f]{12}$`).MatchString(slug) {
		t.Errorf("slug %q not normalized as expected", slug)
	}
	// A base that normalizes to empty falls back to "item".
	if slug := UniqueSlug("run", "!!!"); !regexp.MustCompile(`^item-[0-9a-f]{12}$`).MatchString(slug) {
		t.Errorf("empty-normalized base should fall back to item, got %q", slug)
	}
}
