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

		// Delete cycle nodes
		for _, cycle := range result.Cycles {
			for _, model := range cycle {
				if err := deleteModel(ctx, tx, dialect, tableMap, columnMaps, model, scopeValue, scopeFieldByModel, refs); err != nil {
					return err
				}
			}
		}

		// Delete in reverse topo order
		for i := len(result.Sorted) - 1; i >= 0; i-- {
			model := result.Sorted[i]
			if model == scopeRootModel {
				continue
			}
			if err := deleteModel(ctx, tx, dialect, tableMap, columnMaps, model, scopeValue, scopeFieldByModel, refs); err != nil {
				return err
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
				idCol := colMap["id"]
				if idCol == "" {
					idCol = "id"
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
) error {
	dbTable := tableMap[model]
	if dbTable == "" {
		return nil
	}
	colMap := columnMaps[model]
	if colMap == nil {
		colMap = make(map[string]string)
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
			var ids []any
			for _, r := range records {
				if id, ok := r["id"]; ok {
					if s, ok := id.(string); ok {
						ids = append(ids, s)
					}
				}
			}
			if len(ids) > 0 {
				idCol := colMap["id"]
				if idCol == "" {
					idCol = "id"
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
