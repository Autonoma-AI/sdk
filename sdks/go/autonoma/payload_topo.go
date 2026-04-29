package autonoma

import (
	"fmt"
	"sort"
	"strings"
)

// reservedKeys are keys in entity objects that the SDK interprets specially.
var reservedKeys = map[string]bool{
	"_alias": true,
	"_ref":   true,
}

// collectRefs walks a field value tree and appends every _ref alias found.
func collectRefs(value any, out *[]string) {
	switch v := value.(type) {
	case map[string]any:
		if ref, ok := v["_ref"].(string); ok {
			*out = append(*out, ref)
			return
		}
		for _, child := range v {
			collectRefs(child, out)
		}
	case []any:
		for _, child := range v {
			collectRefs(child, out)
		}
	}
}

// resolveRefs replaces each {"_ref": alias} with its temp id.
func resolveRefs(value any, aliasToTempID map[string]string) any {
	switch v := value.(type) {
	case map[string]any:
		if ref, ok := v["_ref"].(string); ok {
			if real, exists := aliasToTempID[ref]; exists {
				return real
			}
			return v
		}
		out := make(map[string]any, len(v))
		for k, child := range v {
			out[k] = resolveRefs(child, aliasToTempID)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, child := range v {
			out[i] = resolveRefs(child, aliasToTempID)
		}
		return out
	default:
		return value
	}
}

// ResolvePayloadTree topo-sorts a create payload into an ordered list of CreateOp.
//
// create is the dashboard's nested map {model: [entity, ...]}.
// Each entity is a dict; _alias (declared by dependency targets) and _ref
// (declared by dependents, anywhere in the field tree) are the only reserved keys.
//
// Returns an error if the payload references an alias that is never declared,
// or if the alias graph contains a cycle.
func ResolvePayloadTree(create map[string]any) (*ResolvedTree, error) {
	// First pass: assign temp ids and collect alias declarations.
	type rawEntry struct {
		model  string
		tempID string
		entity map[string]any
		alias  string // "" if none
	}

	var entries []rawEntry
	counter := 0
	aliases := make(map[string]string)
	aliasOwnerModel := make(map[string]string)

	for model, entitiesRaw := range create {
		entities, ok := entitiesRaw.([]any)
		if !ok {
			return nil, ErrInvalidBody(fmt.Sprintf("`create.%s` must be a list of entity objects, got %T", model, entitiesRaw))
		}
		for _, entityRaw := range entities {
			entity, ok := entityRaw.(map[string]any)
			if !ok {
				return nil, ErrInvalidBody(fmt.Sprintf("`create.%s` entries must be objects, got %T", model, entityRaw))
			}
			tempID := fmt.Sprintf("__temp_%s_%d", model, counter)
			counter++

			alias := ""
			if a, hasAlias := entity["_alias"]; hasAlias {
				aStr, ok := a.(string)
				if !ok {
					return nil, ErrInvalidBody(`"_alias" must be a string`)
				}
				if _, dup := aliases[aStr]; dup {
					return nil, ErrInvalidBody(fmt.Sprintf(`duplicate _alias "%s"`, aStr))
				}
				aliases[aStr] = tempID
				aliasOwnerModel[aStr] = model
				alias = aStr
			}

			entries = append(entries, rawEntry{
				model:  model,
				tempID: tempID,
				entity: entity,
				alias:  alias,
			})
		}
	}

	// Second pass: collect each entry's dependency aliases and strip reserved keys.
	depsByTempID := make(map[string][]string)
	fieldsByTempID := make(map[string]map[string]any)
	modelByTempID := make(map[string]string)

	for _, entry := range entries {
		var deps []string
		cleaned := make(map[string]any)
		for key, value := range entry.entity {
			if reservedKeys[key] {
				continue
			}
			collectRefs(value, &deps)
			cleaned[key] = resolveRefs(value, aliases)
		}

		// Validate all refs point to known aliases.
		var unknown []string
		seen := make(map[string]bool)
		for _, a := range deps {
			if _, exists := aliases[a]; !exists && !seen[a] {
				unknown = append(unknown, a)
				seen[a] = true
			}
		}
		if len(unknown) > 0 {
			sort.Strings(unknown)
			return nil, ErrInvalidBody(fmt.Sprintf(
				"`create.%s` references unknown alias(es): %s",
				entry.model, strings.Join(unknown, ", ")))
		}

		depsByTempID[entry.tempID] = deps
		fieldsByTempID[entry.tempID] = cleaned
		modelByTempID[entry.tempID] = entry.model
	}

	// Build the temp_id graph and topo-sort.
	inDegree := make(map[string]int, len(entries))
	for _, e := range entries {
		inDegree[e.tempID] = 0
	}
	edges := make(map[string][]string) // dep -> []dependent

	for _, entry := range entries {
		seen := make(map[string]bool)
		for _, depAlias := range depsByTempID[entry.tempID] {
			depTempID := aliases[depAlias]
			if depTempID == entry.tempID || seen[depTempID] {
				continue
			}
			seen[depTempID] = true
			edges[depTempID] = append(edges[depTempID], entry.tempID)
			inDegree[entry.tempID]++
		}
	}

	// Kahn's, preserving payload order as the stable tie-breaker.
	payloadOrder := make(map[string]int, len(entries))
	for idx, e := range entries {
		payloadOrder[e.tempID] = idx
	}

	var ready []string
	for _, e := range entries {
		if inDegree[e.tempID] == 0 {
			ready = append(ready, e.tempID)
		}
	}
	sort.Slice(ready, func(i, j int) bool {
		return payloadOrder[ready[i]] < payloadOrder[ready[j]]
	})

	var sortedTempIDs []string
	for len(ready) > 0 {
		tid := ready[0]
		ready = ready[1:]
		sortedTempIDs = append(sortedTempIDs, tid)
		for _, nxt := range edges[tid] {
			inDegree[nxt]--
			if inDegree[nxt] == 0 {
				ready = append(ready, nxt)
			}
		}
		sort.Slice(ready, func(i, j int) bool {
			return payloadOrder[ready[i]] < payloadOrder[ready[j]]
		})
	}

	if len(sortedTempIDs) != len(entries) {
		var cycleModels []string
		for _, e := range entries {
			if inDegree[e.tempID] > 0 {
				cycleModels = append(cycleModels, modelByTempID[e.tempID])
			}
		}
		return nil, ErrInvalidBody(fmt.Sprintf(
			"cycle detected in _alias/_ref graph: %s",
			strings.Join(cycleModels, ", ")))
	}

	// Build CreateOp list in topo order.
	tree := &ResolvedTree{
		Aliases:           aliases,
		AliasOwnerModel:   aliasOwnerModel,
		AliasDependencies: make(map[string][]string),
	}
	for alias := range aliases {
		tree.AliasDependencies[alias] = depsByTempID[aliases[alias]]
	}
	for _, tid := range sortedTempIDs {
		tree.Ops = append(tree.Ops, CreateOp{
			Model:  modelByTempID[tid],
			Fields: fieldsByTempID[tid],
			TempID: tid,
		})
	}
	return tree, nil
}

// ComputeTeardownOrder orders models for teardown.
//
// With aliasDependencies available (newer refs tokens carry it), we run
// Kahn's topo sort over models and return the reverse topo so children
// are torn down before parents.
//
// Without it (older refs tokens), fall back to reversing the insertion
// order of refs keys (using modelOrder if available).
func ComputeTeardownOrder(
	refs map[string][]map[string]any,
	aliasDeps map[string][]string,
	aliasOwnerModel map[string]string,
	modelOrder []string,
) []string {
	// Use modelOrder if available (preserves creation-time ordering).
	// Otherwise fall back to map keys (non-deterministic in Go).
	var models []string
	if len(modelOrder) > 0 {
		// Use modelOrder but ensure all refs keys are included.
		seen := make(map[string]bool)
		for _, m := range modelOrder {
			if _, ok := refs[m]; ok {
				models = append(models, m)
				seen[m] = true
			}
		}
		for m := range refs {
			if !seen[m] {
				models = append(models, m)
			}
		}
	} else {
		for m := range refs {
			models = append(models, m)
		}
	}

	if len(aliasDeps) == 0 || len(aliasOwnerModel) == 0 {
		// Reverse insertion order.
		reversed := make([]string, len(models))
		for i, m := range models {
			reversed[len(models)-1-i] = m
		}
		return reversed
	}

	// Build model -> {model dependencies} by aggregating per-alias edges.
	modelSet := make(map[string]bool, len(models))
	for _, m := range models {
		modelSet[m] = true
	}
	modelDeps := make(map[string]map[string]bool, len(models))
	for _, m := range models {
		modelDeps[m] = make(map[string]bool)
	}

	for alias, deps := range aliasDeps {
		owner, ok := aliasOwnerModel[alias]
		if !ok || !modelSet[owner] {
			continue
		}
		for _, depAlias := range deps {
			depModel, ok := aliasOwnerModel[depAlias]
			if !ok || depModel == owner || !modelSet[depModel] {
				continue
			}
			modelDeps[owner][depModel] = true
		}
	}

	// Kahn's over models.
	inDegree := make(map[string]int, len(models))
	adj := make(map[string][]string, len(models))
	for _, m := range models {
		inDegree[m] = 0
	}
	for owner, deps := range modelDeps {
		for depModel := range deps {
			adj[depModel] = append(adj[depModel], owner)
			inDegree[owner]++
		}
	}

	payloadOrder := make(map[string]int, len(models))
	for i, m := range models {
		payloadOrder[m] = i
	}

	var ready []string
	for _, m := range models {
		if inDegree[m] == 0 {
			ready = append(ready, m)
		}
	}
	sort.Slice(ready, func(i, j int) bool {
		return payloadOrder[ready[i]] < payloadOrder[ready[j]]
	})

	var upOrder []string
	for len(ready) > 0 {
		m := ready[0]
		ready = ready[1:]
		upOrder = append(upOrder, m)
		for _, nxt := range adj[m] {
			inDegree[nxt]--
			if inDegree[nxt] == 0 {
				ready = append(ready, nxt)
			}
		}
		sort.Slice(ready, func(i, j int) bool {
			return payloadOrder[ready[i]] < payloadOrder[ready[j]]
		})
	}

	if len(upOrder) != len(models) {
		// Shouldn't happen (cycles rejected at up). Fall back.
		reversed := make([]string, len(models))
		for i, m := range models {
			reversed[len(models)-1-i] = m
		}
		return reversed
	}

	// Reverse the up order for teardown.
	reversed := make([]string, len(upOrder))
	for i, m := range upOrder {
		reversed[len(upOrder)-1-i] = m
	}
	return reversed
}
