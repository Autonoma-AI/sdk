package autonoma

import (
	"context"
	"fmt"
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

		// Partition sorted nodes: those that depend on cycle nodes must be deleted
		// BEFORE cycles, those that cycle nodes depend on must be deleted AFTER.
		cycleNodeSet := make(map[string]bool)
		for _, cycle := range result.Cycles {
			for _, n := range cycle {
				cycleNodeSet[n] = true
			}
		}

		if len(cycleNodeSet) > 0 {
			// Build dependency map: node → set of nodes it depends on
			dependsOn := make(map[string]map[string]bool)
			for _, edge := range schema.Edges {
				if edge.From != edge.To {
					if dependsOn[edge.From] == nil {
						dependsOn[edge.From] = make(map[string]bool)
					}
					dependsOn[edge.From][edge.To] = true
				}
			}

			// Mark nodes that transitively depend on cycle nodes
			dependsOnCycle := make(map[string]bool)
			for _, node := range result.Sorted {
				deps := dependsOn[node]
				for dep := range deps {
					if cycleNodeSet[dep] || dependsOnCycle[dep] {
						dependsOnCycle[node] = true
						break
					}
				}
			}

			var cycleDependents, cycleDeps []string
			for _, n := range result.Sorted {
				if dependsOnCycle[n] {
					cycleDependents = append(cycleDependents, n)
				} else {
					cycleDeps = append(cycleDeps, n)
				}
			}

			for i := len(cycleDependents) - 1; i >= 0; i-- {
				model := cycleDependents[i]
				if model == scopeRootModel {
					continue
				}
				if err := deleteModel(ctx, tx, dialect, tableMap, columnMaps, model, scopeValue, scopeFieldByModel, refs, schema); err != nil {
					return err
				}
			}

			for _, cycle := range result.Cycles {
				for _, model := range cycle {
					if err := deleteModel(ctx, tx, dialect, tableMap, columnMaps, model, scopeValue, scopeFieldByModel, refs, schema); err != nil {
						return err
					}
				}
			}

			for i := len(cycleDeps) - 1; i >= 0; i-- {
				model := cycleDeps[i]
				if model == scopeRootModel {
					continue
				}
				if err := deleteModel(ctx, tx, dialect, tableMap, columnMaps, model, scopeValue, scopeFieldByModel, refs, schema); err != nil {
					return err
				}
			}
		} else {
			for i := len(result.Sorted) - 1; i >= 0; i-- {
				model := result.Sorted[i]
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
