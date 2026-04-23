package autonoma

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestResolveTokensTestRunID(t *testing.T) {
	out, err := ResolveTokens(map[string]any{"email": "alice-{{testRunId}}@test.local"}, "run-123", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	expected := map[string]any{"email": "alice-run-123@test.local"}
	if !reflect.DeepEqual(out, expected) {
		t.Fatalf("got %v, want %v", out, expected)
	}
}

func TestResolveTokensIndex(t *testing.T) {
	out, err := ResolveTokens(map[string]any{"slot": "pos-{{index}}"}, "r", 4)
	if err != nil {
		t.Fatal(err)
	}
	expected := map[string]any{"slot": "pos-4"}
	if !reflect.DeepEqual(out, expected) {
		t.Fatalf("got %v, want %v", out, expected)
	}
}

func TestResolveTokensCycleWraps(t *testing.T) {
	cases := []struct {
		index int
		want  string
	}{{0, "a"}, {1, "b"}, {2, "a"}}
	for _, c := range cases {
		out, err := ResolveTokens("{{cycle(a,b)}}", "r", c.index)
		if err != nil {
			t.Fatal(err)
		}
		if out != c.want {
			t.Fatalf("index=%d: got %v, want %v", c.index, out, c.want)
		}
	}
}

func TestResolveTokensCycleQuoted(t *testing.T) {
	out, err := ResolveTokens("{{cycle('WEB','IOS','ANDROID')}}", "r", 1)
	if err != nil {
		t.Fatal(err)
	}
	if out != "IOS" {
		t.Fatalf("got %v, want IOS", out)
	}
}

func TestResolveTokensNested(t *testing.T) {
	input := map[string]any{
		"users": []any{
			map[string]any{"email": "u-{{testRunId}}@t.local"},
			map[string]any{"email": "v-{{testRunId}}@t.local"},
		},
		"tags": []any{"{{testRunId}}-a", "{{testRunId}}-b"},
	}
	expected := map[string]any{
		"users": []any{
			map[string]any{"email": "u-xyz@t.local"},
			map[string]any{"email": "v-xyz@t.local"},
		},
		"tags": []any{"xyz-a", "xyz-b"},
	}
	out, err := ResolveTokens(input, "xyz", 0)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(out, expected) {
		t.Fatalf("got %v, want %v", out, expected)
	}
}

func TestResolveTokensMultipleInOneString(t *testing.T) {
	out, err := ResolveTokens("{{testRunId}}-{{index}}", "run", 7)
	if err != nil {
		t.Fatal(err)
	}
	if out != "run-7" {
		t.Fatalf("got %v, want run-7", out)
	}
}

func TestResolveTokensUnknownRaises(t *testing.T) {
	_, err := ResolveTokens(map[string]any{"x": "hello-{{mystery}}"}, "r", 0)
	if err == nil {
		t.Fatal("expected error")
	}
	var ae *AutonomaError
	if !errors.As(err, &ae) {
		t.Fatalf("expected AutonomaError, got %T: %v", err, err)
	}
	if ae.Code != "UNRESOLVED_TOKEN" {
		t.Fatalf("expected UNRESOLVED_TOKEN, got %s", ae.Code)
	}
	if !strings.Contains(ae.Message, "mystery") {
		t.Fatalf("expected message to contain mystery, got %q", ae.Message)
	}
}

func TestResolveTokensPrimitivesPassThrough(t *testing.T) {
	for _, v := range []any{42, true, nil} {
		out, err := ResolveTokens(v, "r", 0)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(out, v) {
			t.Fatalf("got %v, want %v", out, v)
		}
	}
}

func TestResolveTokensStringWithoutTokens(t *testing.T) {
	out, err := ResolveTokens("plain string", "r", 0)
	if err != nil {
		t.Fatal(err)
	}
	if out != "plain string" {
		t.Fatalf("got %v, want plain string", out)
	}
}
