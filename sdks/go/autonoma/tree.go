package autonoma

import (
	"fmt"
	"strings"
)

var reservedKeys = map[string]bool{
	"_alias": true,
	"_ref":   true,
}

// CreateOp represents a create operation produced by the tree resolver.
type CreateOp struct {
	Model  string
	Fields map[string]any
	TempID string
}

// DeferredUpdate represents a deferred FK update for circular dependencies.
type DeferredUpdate struct {
	TargetTempID string
	Model        string
	Field        string
	RefAlias     string
}

// ResolvedTree is the result of resolving a tree scenario.
type ResolvedTree struct {
	Ops             []CreateOp
	DeferredUpdates []DeferredUpdate
	Aliases         map[string]string
}

// ResolveTree resolves a nested scenario tree into an ordered list of create operations.
func ResolveTree(create map[string][]map[string]any, schema SchemaInfo) *ResolvedTree {
	relationByParentField := make(map[string]SchemaRelation)
	for _, rel := range schema.Relations {
		key := rel.ParentModel + "." + rel.ParentField
		relationByParentField[key] = rel
	}

	// Determine FK direction for each relation
	fkOnParent := make(map[string]bool)
	for _, rel := range schema.Relations {
		for _, edge := range schema.Edges {
			if edge.LocalField == rel.ChildField && (edge.From == rel.ParentModel || edge.From == rel.ChildModel) {
				if edge.From == rel.ParentModel {
					fkOnParent[rel.ParentModel+"."+rel.ParentField] = true
				}
				break
			}
		}
	}

	aliases := make(map[string]string)
	var ops []CreateOp
	var deferredUpdates []DeferredUpdate
	tempCounter := 0

	makeTempID := func(model string) string {
		id := fmt.Sprintf("__temp_%s_%d", model, tempCounter)
		tempCounter++
		return id
	}

	type childEntry struct {
		relation   SchemaRelation
		value      any
		fkOnParent bool
	}

	var walkNode func(modelName string, node map[string]any, parentTempID string, parentRelation *SchemaRelation, parentFKOnParent bool) string

	walkNode = func(modelName string, node map[string]any, parentTempID string, parentRelation *SchemaRelation, parentFKOnParent bool) string {
		fields := make(map[string]any)
		var preChildren []childEntry
		var postChildren []childEntry
		alias, _ := node["_alias"].(string)
		tempID := makeTempID(modelName)

		for key, value := range node {
			if reservedKeys[key] {
				continue
			}

			// Look up relation by exact key, then try fallbacks
			exactKey := modelName + "." + key
			prefixed := modelName + "." + strings.ToLower(modelName[:1]) + modelName[1:] + strings.ToUpper(key[:1]) + key[1:]

			rel, found := relationByParentField[exactKey]
			matchedKey := exactKey
			if !found {
				rel, found = relationByParentField[prefixed]
				matchedKey = prefixed
			}
			if !found {
				// Fallback: match by child model name
				for relKey, r := range relationByParentField {
					if strings.HasPrefix(relKey, modelName+".") && strings.EqualFold(r.ChildModel, key) {
						rel = r
						matchedKey = relKey
						found = true
						break
					}
				}
			}

			if found {
				isOnParent := fkOnParent[matchedKey]
				if isOnParent {
					preChildren = append(preChildren, childEntry{relation: rel, value: value, fkOnParent: true})
				} else {
					postChildren = append(postChildren, childEntry{relation: rel, value: value, fkOnParent: false})
				}
				continue
			}

			// Check for _ref
			if m, ok := value.(map[string]any); ok {
				if refAlias, hasRef := m["_ref"]; hasRef {
					refStr := fmt.Sprintf("%v", refAlias)
					refTempID, aliasExists := aliases[refStr]
					if !aliasExists {
						deferredUpdates = append(deferredUpdates, DeferredUpdate{
							TargetTempID: tempID,
							Model:        modelName,
							Field:        key,
							RefAlias:     refStr,
						})
						continue
					}
					fields[key] = refTempID
					continue
				}
			}

			fields[key] = value
		}

		// Wire FK to parent
		if parentRelation != nil && parentTempID != "" && !parentFKOnParent {
			fields[parentRelation.ChildField] = parentTempID
		}

		// Process pre-children
		for _, child := range preChildren {
			if arr, ok := child.value.([]any); ok {
				for _, item := range arr {
					if m, ok := item.(map[string]any); ok {
						childTempID := walkNode(child.relation.ChildModel, m, tempID, &child.relation, true)
						fields[child.relation.ChildField] = childTempID
					}
				}
			}
		}

		// Create this node
		ops = append(ops, CreateOp{Model: modelName, Fields: fields, TempID: tempID})
		if alias != "" {
			aliases[alias] = tempID
		}

		// Process post-children
		for _, child := range postChildren {
			if arr, ok := child.value.([]any); ok {
				for _, item := range arr {
					if m, ok := item.(map[string]any); ok {
						walkNode(child.relation.ChildModel, m, tempID, &child.relation, false)
					}
				}
			}
		}

		return tempID
	}

	for modelName, nodes := range create {
		for _, node := range nodes {
			walkNode(modelName, node, "", nil, false)
		}
	}

	return &ResolvedTree{
		Ops:             ops,
		DeferredUpdates: deferredUpdates,
		Aliases:         aliases,
	}
}

