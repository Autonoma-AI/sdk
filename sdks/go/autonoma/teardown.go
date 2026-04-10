package autonoma

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

// Teardown deletes all data scoped to a value, in reverse topological order.
func Teardown(
	ctx context.Context,
	executor SQLExecutor,
	dialect *Dialect,
	tableMap map[string]string,
	columnMaps map[string]map[string]string,
	schema SchemaInfo,
	scopeValue string,
	refs map[string][]map[string]any,
) error {
	// Find scope root: the model that the scopeField FK points TO
	var scopeRootModel string
	for _, edge := range schema.Edges {
		if strings.EqualFold(edge.LocalField, schema.ScopeField) && edge.To != edge.From {
			scopeRootModel = edge.To
			break
		}
	}

	// Build map: model → FK field name that points to the scope root
	scopeFieldByModel := make(map[string]string)
	if scopeRootModel != "" {
		for _, edge := range schema.Edges {
			if edge.To == scopeRootModel && edge.From != scopeRootModel {
				scopeFieldByModel[edge.From] = edge.LocalField
			}
		}
	}

	modelNames := make([]string, len(schema.Models))
	for i, m := range schema.Models {
		modelNames[i] = m.Name
	}

	result := TopoSort(modelNames, schema.Edges)

	return executor.Transaction(ctx, func(tx SQLExecutor) error {
		// Break cycles by nullifying deferrable FKs
		for _, cycle := range result.Cycles {
			edge := FindDeferrableEdge(cycle, schema.Edges)
			if edge != nil {
				scopeFK, hasScopeFK := scopeFieldByModel[edge.From]
				if hasScopeFK {
					dbTable := tableMap[edge.From]
					colMap := columnMaps[edge.From]
					if colMap == nil {
						colMap = make(map[string]string)
					}
					if dbTable != "" {
						dbFKCol := colMap[edge.LocalField]
						if dbFKCol == "" {
							dbFKCol = edge.LocalField
						}
						dbScopeCol := colMap[scopeFK]
						if dbScopeCol == "" {
							dbScopeCol = scopeFK
						}
						sql := fmt.Sprintf("UPDATE %s SET %s = NULL WHERE %s = %s",
							dialect.QuoteID(dbTable),
							dialect.QuoteID(dbFKCol),
							dialect.QuoteID(dbScopeCol),
							dialect.Param(1))
						if _, err := tx.Query(ctx, sql, scopeValue); err != nil {
							return err
						}
					}
				}
			}
		}

		// Build condensation graph: each SCC is a super-node, each sorted node
		// is its own node. Topo-sort the condensation DAG and delete in reverse
		// order so that dependents of cycles are deleted before the cycle itself.
		var components [][]string
		nodeToComp := make(map[string]int)

		for _, cycle := range result.Cycles {
			idx := len(components)
			components = append(components, cycle)
			for _, node := range cycle {
				nodeToComp[node] = idx
			}
		}
		for _, node := range result.Sorted {
			nodeToComp[node] = len(components)
			components = append(components, []string{node})
		}

		// Build condensation DAG edges (dependency → dependent)
		compCount := len(components)
		condAdj := make([]map[int]bool, compCount)
		condInDeg := make([]int, compCount)
		for i := 0; i < compCount; i++ {
			condAdj[i] = make(map[int]bool)
		}
		for _, edge := range schema.Edges {
			if edge.From == edge.To {
				continue
			}
			fc, fcOk := nodeToComp[edge.From]
			tc, tcOk := nodeToComp[edge.To]
			if fcOk && tcOk && fc != tc && !condAdj[tc][fc] {
				condAdj[tc][fc] = true
				condInDeg[fc]++
			}
		}

		// Kahn's algorithm on the condensation DAG
		var condQueue []int
		for i := 0; i < compCount; i++ {
			if condInDeg[i] == 0 {
				condQueue = append(condQueue, i)
			}
		}
		sort.Ints(condQueue)
		var condOrder []int
		for len(condQueue) > 0 {
			sort.Ints(condQueue)
			idx := condQueue[0]
			condQueue = condQueue[1:]
			condOrder = append(condOrder, idx)
			for neighbor := range condAdj[idx] {
				condInDeg[neighbor]--
				if condInDeg[neighbor] == 0 {
					condQueue = append(condQueue, neighbor)
				}
			}
		}

		// Delete in reverse condensation order (dependents first)
		for i := len(condOrder) - 1; i >= 0; i-- {
			for _, model := range components[condOrder[i]] {
				if model == scopeRootModel {
					continue
				}
				if err := deleteModel(ctx, tx, dialect, tableMap, columnMaps, model, scopeValue, scopeFieldByModel, refs, schema); err != nil {
					return err
				}
			}
		}

		// Delete scope root last
		if scopeRootModel != "" {
			dbTable := tableMap[scopeRootModel]
			colMap := columnMaps[scopeRootModel]
			if colMap == nil {
				colMap = make(map[string]string)
			}
			if dbTable != "" {
				// Bug 4: find actual PK field name from schema (composite PK: prefer "id")
				rootPkFieldName := "id"
				for _, mi := range schema.Models {
					if mi.Name == scopeRootModel {
						var firstId string
						for _, f := range mi.Fields {
							if f.IsId {
								if firstId == "" {
									firstId = f.Name
								}
								if strings.EqualFold(f.Name, "id") {
									rootPkFieldName = f.Name
									firstId = ""
									break
								}
							}
						}
						if firstId != "" {
							rootPkFieldName = firstId
						}
						break
					}
				}
				idCol := colMap[rootPkFieldName]
				if idCol == "" {
					idCol = rootPkFieldName
				}
				sql := fmt.Sprintf("DELETE FROM %s WHERE %s = %s",
					dialect.QuoteID(dbTable),
					dialect.QuoteID(idCol),
					dialect.Param(1))
				if _, err := tx.Query(ctx, sql, scopeValue); err != nil {
					return err
				}
			}
		}

		return nil
	})
}

func deleteModel(
	ctx context.Context,
	tx SQLExecutor,
	dialect *Dialect,
	tableMap map[string]string,
	columnMaps map[string]map[string]string,
	model string,
	scopeValue string,
	scopeFieldByModel map[string]string,
	refs map[string][]map[string]any,
	schema SchemaInfo,
) error {
	dbTable := tableMap[model]
	if dbTable == "" {
		return nil
	}
	colMap := columnMaps[model]
	if colMap == nil {
		colMap = make(map[string]string)
	}

	// Bug 4: find actual PK field name from schema
	// When multiple IsId fields exist (composite PK), prefer the one named "id"
	pkFieldName := "id"
	for _, mi := range schema.Models {
		if mi.Name == model {
			var firstId string
			for _, f := range mi.Fields {
				if f.IsId {
					if firstId == "" {
						firstId = f.Name
					}
					if strings.EqualFold(f.Name, "id") {
						pkFieldName = f.Name
						firstId = ""
						break
					}
				}
			}
			if firstId != "" {
				pkFieldName = firstId
			}
			break
		}
	}

	scopeFK, hasScopeFK := scopeFieldByModel[model]
	if hasScopeFK {
		dbCol := colMap[scopeFK]
		if dbCol == "" {
			dbCol = scopeFK
		}
		sql := fmt.Sprintf("DELETE FROM %s WHERE %s = %s",
			dialect.QuoteID(dbTable),
			dialect.QuoteID(dbCol),
			dialect.Param(1))
		_, err := tx.Query(ctx, sql, scopeValue)
		return err
	}

	if refs != nil {
		records := refs[model]
		if len(records) > 0 {
			// Bug 3: accept any non-nil value, not just strings
			var ids []any
			for _, r := range records {
				if id, ok := r[pkFieldName]; ok && id != nil {
					ids = append(ids, id)
				}
			}
			if len(ids) > 0 {
				idCol := colMap[pkFieldName]
				if idCol == "" {
					idCol = pkFieldName
				}
				var placeholders []string
				for i := range ids {
					placeholders = append(placeholders, dialect.Param(i+1))
				}
				sql := fmt.Sprintf("DELETE FROM %s WHERE %s IN (%s)",
					dialect.QuoteID(dbTable),
					dialect.QuoteID(idCol),
					strings.Join(placeholders, ", "))
				_, err := tx.Query(ctx, sql, ids...)
				return err
			}
		}
	}

	return nil
}
