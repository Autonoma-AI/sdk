package autonoma

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

// TeardownOrderInfo holds the precomputed teardown order for a schema.
type TeardownOrderInfo struct {
	Order            []string
	ScopeRootModel   string
	Cycles           [][]string
	ScopeFieldByModel map[string]string
}

// ComputeTeardownOrder computes the deletion order for models (reverse topological order).
func ComputeTeardownOrder(schema SchemaInfo) TeardownOrderInfo {
	var scopeRootModel string
	for _, edge := range schema.Edges {
		if strings.EqualFold(edge.LocalField, schema.ScopeField) && edge.To != edge.From {
			scopeRootModel = edge.To
			break
		}
	}

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

	// Build condensation graph
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

	// Flatten in reverse condensation order, excluding scope root
	var order []string
	for i := len(condOrder) - 1; i >= 0; i-- {
		for _, model := range components[condOrder[i]] {
			if model != scopeRootModel {
				order = append(order, model)
			}
		}
	}

	return TeardownOrderInfo{
		Order:            order,
		ScopeRootModel:   scopeRootModel,
		Cycles:           result.Cycles,
		ScopeFieldByModel: scopeFieldByModel,
	}
}

// Teardown deletes all data scoped to a value, in reverse topological order.
// skipModels contains model names that should be excluded from SQL deletion
// (because they were already handled by factory teardown).
func Teardown(
	ctx context.Context,
	executor SQLExecutor,
	dialect *Dialect,
	tableMap map[string]string,
	columnMaps map[string]map[string]string,
	schema SchemaInfo,
	scopeValue string,
	refs map[string][]map[string]any,
	skipModels map[string]bool,
) error {
	tdInfo := ComputeTeardownOrder(schema)

	return executor.Transaction(ctx, func(tx SQLExecutor) error {
		// Break cycles by nullifying deferrable FKs
		for _, cycle := range tdInfo.Cycles {
			edge := FindDeferrableEdge(cycle, schema.Edges)
			if edge != nil {
				scopeFK, hasScopeFK := tdInfo.ScopeFieldByModel[edge.From]
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

		// Delete in order (dependents first), skipping factory-teardown models
		for _, model := range tdInfo.Order {
			if skipModels[model] {
				continue
			}
			if err := deleteModel(ctx, tx, dialect, tableMap, columnMaps, model, scopeValue, tdInfo.ScopeFieldByModel, refs, schema); err != nil {
				return err
			}
		}

		// Delete scope root last (unless skipped by factory teardown)
		if tdInfo.ScopeRootModel == "" || skipModels[tdInfo.ScopeRootModel] {
			return nil
		}

		dbTable := tableMap[tdInfo.ScopeRootModel]
		colMap := columnMaps[tdInfo.ScopeRootModel]
		if colMap == nil {
			colMap = make(map[string]string)
		}
		if dbTable != "" {
			rootPkFieldName := "id"
			for _, mi := range schema.Models {
				if mi.Name == tdInfo.ScopeRootModel {
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
