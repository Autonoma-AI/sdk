package autonoma

import (
	"fmt"
	"math/rand"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var templateRE = regexp.MustCompile(`\{\{(.+?)\}\}`)
var fullTemplateRE = regexp.MustCompile(`^\{\{(.+?)\}\}$`)

// TemplateContext holds the variables available to template expressions.
type TemplateContext struct {
	TestRunID string
	Index     int
}

// ResolveTemplate resolves all {{...}} expressions in a value.
// Handles strings, maps, and slices recursively.
func ResolveTemplate(value any, ctx TemplateContext) any {
	switch v := value.(type) {
	case string:
		return resolveString(v, ctx)
	case []any:
		result := make([]any, len(v))
		for i, item := range v {
			result[i] = ResolveTemplate(item, ctx)
		}
		return result
	case map[string]any:
		result := make(map[string]any, len(v))
		for k, val := range v {
			result[k] = ResolveTemplate(val, ctx)
		}
		return result
	default:
		return value
	}
}

func resolveString(str string, ctx TemplateContext) any {
	// If the entire string is a single expression, return the raw value (preserving type)
	if m := fullTemplateRE.FindStringSubmatch(str); m != nil {
		return evaluateExpression(m[1], ctx)
	}

	// Otherwise, interpolate expressions into the string
	return templateRE.ReplaceAllStringFunc(str, func(match string) string {
		inner := templateRE.FindStringSubmatch(match)
		if inner == nil {
			return match
		}
		val := evaluateExpression(inner[1], ctx)
		return fmt.Sprintf("%v", val)
	})
}

var (
	cycleRE     = regexp.MustCompile(`^cycle\(\[(.+)\]\)$`)
	pickRE      = regexp.MustCompile(`^pick\(\[(.+)\]\)$`)
	randIntRE   = regexp.MustCompile(`^random\.int\((\d+),\s*(\d+)\)$`)
	randFloatRE = regexp.MustCompile(`^random\.float\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)\)$`)
	daysAgoRE   = regexp.MustCompile(`^daysAgo\((\d+)\)$`)
)

func evaluateExpression(expr string, ctx TemplateContext) any {
	expr = strings.TrimSpace(expr)

	switch expr {
	case "testRunId":
		return ctx.TestRunID
	case "index":
		return float64(ctx.Index)
	case "index1":
		return float64(ctx.Index + 1)
	case "now()":
		return time.Now().UTC().Format(time.RFC3339Nano)
	}

	// cycle([...])
	if m := cycleRE.FindStringSubmatch(expr); m != nil {
		items := parseArrayLiteral(m[1])
		return items[ctx.Index%len(items)]
	}

	// pick([...])
	if m := pickRE.FindStringSubmatch(expr); m != nil {
		items := parseArrayLiteral(m[1])
		return items[rand.Intn(len(items))]
	}

	// random.int(a,b)
	if m := randIntRE.FindStringSubmatch(expr); m != nil {
		min, _ := strconv.Atoi(m[1])
		max, _ := strconv.Atoi(m[2])
		return float64(rand.Intn(max-min+1) + min)
	}

	// random.float(a,b)
	if m := randFloatRE.FindStringSubmatch(expr); m != nil {
		min, _ := strconv.ParseFloat(m[1], 64)
		max, _ := strconv.ParseFloat(m[2], 64)
		return rand.Float64()*(max-min) + min
	}

	// daysAgo(n)
	if m := daysAgoRE.FindStringSubmatch(expr); m != nil {
		days, _ := strconv.Atoi(m[1])
		t := time.Now().UTC().Add(-time.Duration(days) * 24 * time.Hour)
		return t.Format(time.RFC3339Nano)
	}

	panic(fmt.Sprintf("Template error: unknown expression '%s'", expr))
}

func parseArrayLiteral(raw string) []string {
	parts := strings.Split(raw, ",")
	result := make([]string, len(parts))
	for i, s := range parts {
		s = strings.TrimSpace(s)
		// Strip surrounding quotes
		if (strings.HasPrefix(s, "'") && strings.HasSuffix(s, "'")) ||
			(strings.HasPrefix(s, "\"") && strings.HasSuffix(s, "\"")) {
			s = s[1 : len(s)-1]
		}
		result[i] = s
	}
	return result
}

