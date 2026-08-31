package autonoma

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
)

// Deterministic uniqueness helpers seeded from testRunId. A scenario's data
// needs stable keys across runs but unique values per run (unique emails, org
// slugs, ids). These derive that uniqueness from (testRunId, ...parts): the
// same inputs always produce the same output within a run, so a scenario's Up
// and a later Down compute identical values without storing them.
//
// The recipe is sha256(testRunId + (" " + part) for each part), hex-encoded,
// truncated to the first 12 chars - and MUST match the other language SDKs
// byte-for-byte for cross-language conformance.

const uniqueTokenLength = 12

var (
	slugNonAlnum    = regexp.MustCompile(`[^a-z0-9]+`)
	slugTrimHyphens = regexp.MustCompile(`^-+|-+$`)
)

func uniqueDigest(testRunID string, parts ...string) string {
	h := sha256.New()
	h.Write([]byte(testRunID))
	for _, part := range parts {
		h.Write([]byte(" "))
		h.Write([]byte(part))
	}
	return hex.EncodeToString(h.Sum(nil))
}

// UniqueToken returns a short hex token, deterministic per (testRunId, ...parts).
func UniqueToken(testRunID string, parts ...string) string {
	return uniqueDigest(testRunID, parts...)[:uniqueTokenLength]
}

// UniqueID returns an id like "user_1a2b3c4d5e6f", deterministic per inputs.
// An empty prefix defaults to "id".
func UniqueID(testRunID string, prefix string, parts ...string) string {
	if prefix == "" {
		prefix = "id"
	}
	tokenParts := append([]string{prefix}, parts...)
	return prefix + "_" + UniqueToken(testRunID, tokenParts...)
}

// UniqueSlug returns a URL-safe slug like "acme-1a2b3c4d5e6f", deterministic
// per inputs. An empty base defaults to "item".
func UniqueSlug(testRunID string, base string, parts ...string) string {
	if base == "" {
		base = "item"
	}
	tokenParts := append([]string{base}, parts...)
	token := UniqueToken(testRunID, tokenParts...)
	normalized := slugTrimHyphens.ReplaceAllString(
		slugNonAlnum.ReplaceAllString(strings.ToLower(base), "-"), "")
	if normalized == "" {
		normalized = "item"
	}
	return normalized + "-" + token
}

// UniqueEmail returns an email like "user+1a2b3c4d5e6f@example.com",
// deterministic per inputs. Empty local/domain default to "user"/"example.com".
func UniqueEmail(testRunID string, local string, domain string) string {
	if local == "" {
		local = "user"
	}
	if domain == "" {
		domain = "example.com"
	}
	return local + "+" + UniqueToken(testRunID, local, domain) + "@" + domain
}
