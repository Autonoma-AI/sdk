package autonoma

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
)

// CreateEntities inserts entities via raw SQL. Entities arrive pre-sorted by FK order.
func CreateEntities(
	ctx context.Context,
	executor SQLExecutor,
	dialect *Dialect,
	tableMap map[string]string,
	columnMaps map[string]map[string]string,
	spec map[string]ResolvedEntitySpec,
	enumTypeMaps map[string]map[string]string,
) (map[string][]map[string]any, error) {
	results := make(map[string][]map[string]any)

	for model, entitySpec := range spec {
		dbTable, ok := tableMap[model]
		if !ok {
			return nil, fmt.Errorf("unknown model %q. Not found in database tables", model)
		}
		colMap := columnMaps[model]
		if colMap == nil {
			colMap = make(map[string]string)
		}
		enumTypeMap := enumTypeMaps[model]
		if enumTypeMap == nil {
			enumTypeMap = make(map[string]string)
		}

		var created []map[string]any
		for _, fields := range entitySpec.Fields {
			records, err := insertOne(ctx, executor, dialect, dbTable, colMap, enumTypeMap, fields)
			if err != nil {
				return nil, err
			}
			if len(records) > 0 {
				created = append(created, records[0])
			}
		}
		results[model] = created
	}

	return results, nil
}

// UpdateEntity updates a single record by primary key. Used for circular FK backfill.
func UpdateEntity(
	ctx context.Context,
	executor SQLExecutor,
	dialect *Dialect,
	tableMap map[string]string,
	columnMaps map[string]map[string]string,
	model string,
	id string,
	fields map[string]any,
	enumTypeMaps map[string]map[string]string,
) error {
	dbTable, ok := tableMap[model]
	if !ok {
		return fmt.Errorf("unknown model %q for update", model)
	}
	colMap := columnMaps[model]
	if colMap == nil {
		colMap = make(map[string]string)
	}
	enumTypeMap := enumTypeMaps[model]
	if enumTypeMap == nil {
		enumTypeMap = make(map[string]string)
	}

	var setClauses []string
	var params []any
	paramIdx := 1

	for fieldName, value := range fields {
		dbCol := colMap[fieldName]
		if dbCol == "" {
			dbCol = fieldName
		}
		setClauses = append(setClauses, fmt.Sprintf("%s = %s", dialect.QuoteID(dbCol), castParam(dialect, paramIdx, enumTypeMap, fieldName)))
		params = append(params, serializeValue(value, dialect))
		paramIdx++
	}

	idCol := colMap["id"]
	if idCol == "" {
		idCol = "id"
	}
	params = append(params, id)

	sql := fmt.Sprintf("UPDATE %s SET %s WHERE %s = %s",
		dialect.QuoteID(dbTable),
		strings.Join(setClauses, ", "),
		dialect.QuoteID(idCol),
		dialect.Param(paramIdx))

	_, err := executor.Query(ctx, sql, params...)
	return err
}

func insertOne(
	ctx context.Context,
	executor SQLExecutor,
	dialect *Dialect,
	dbTable string,
	colMap map[string]string,
	enumTypeMap map[string]string,
	fields map[string]any,
) ([]map[string]any, error) {
	// Generate client-side ID if needed
	idFieldName := reverseGetMap(colMap, findIDCol(colMap))
	if idFieldName != "" {
		if _, exists := fields[idFieldName]; !exists {
			fieldsCopy := make(map[string]any, len(fields)+1)
			for k, v := range fields {
				fieldsCopy[k] = v
			}
			fieldsCopy[idFieldName] = uuid.New().String()
			fields = fieldsCopy
		}
	}

	// Remove "id" key if it exists as nil
	cleanFields := make(map[string]any)
	for k, v := range fields {
		if k == "id" && v == nil {
			continue
		}
		cleanFields[k] = v
	}
	fields = cleanFields

	if len(fields) == 0 {
		rows, err := executor.Query(ctx, fmt.Sprintf("INSERT INTO %s DEFAULT VALUES RETURNING *", dialect.QuoteID(dbTable)))
		if err != nil {
			return nil, err
		}
		return mapRowsBack(rows, colMap), nil
	}

	var dbCols []string
	var params []any
	var placeholders []string
	paramIdx := 1

	for fieldName, value := range fields {
		dbCol := colMap[fieldName]
		if dbCol == "" {
			dbCol = fieldName
		}
		dbCols = append(dbCols, dialect.QuoteID(dbCol))
		placeholders = append(placeholders, castParam(dialect, paramIdx, enumTypeMap, fieldName))
		params = append(params, serializeValue(value, dialect))
		paramIdx++
	}

	colList := strings.Join(dbCols, ", ")
	valList := strings.Join(placeholders, ", ")

	if dialect.SupportsReturning {
		sql := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s) RETURNING *",
			dialect.QuoteID(dbTable), colList, valList)
		rows, err := executor.Query(ctx, sql, params...)
		if err != nil {
			return nil, err
		}
		return mapRowsBack(rows, colMap), nil
	}

	// MySQL: INSERT then SELECT
	sql := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)",
		dialect.QuoteID(dbTable), colList, valList)
	_, err := executor.Query(ctx, sql, params...)
	if err != nil {
		return nil, err
	}

	idCol := findIDCol(colMap)
	idValue := fields[idFieldName]
	if idFieldName == "" {
		idValue = fields["id"]
	}

	selectSQL := fmt.Sprintf("SELECT * FROM %s WHERE %s = %s",
		dialect.QuoteID(dbTable), dialect.QuoteID(idCol), dialect.Param(1))
	rows, err := executor.Query(ctx, selectSQL, idValue)
	if err != nil {
		return nil, err
	}
	return mapRowsBack(rows, colMap), nil
}

func mapRowsBack(rows []map[string]any, colMap map[string]string) []map[string]any {
	if len(colMap) == 0 {
		return rows
	}

	reverse := make(map[string]string, len(colMap))
	for fieldName, dbCol := range colMap {
		reverse[dbCol] = fieldName
	}

	result := make([]map[string]any, len(rows))
	for i, row := range rows {
		mapped := make(map[string]any, len(row))
		for key, value := range row {
			fieldName := reverse[key]
			if fieldName == "" {
				fieldName = key
			}
			mapped[fieldName] = value
		}
		result[i] = mapped
	}
	return result
}

func findIDCol(colMap map[string]string) string {
	if v, ok := colMap["id"]; ok {
		return v
	}
	return "id"
}

func castParam(dialect *Dialect, paramIdx int, enumTypeMap map[string]string, fieldName string) string {
	placeholder := dialect.Param(paramIdx)
	if dialect.Name == "postgres" {
		if enumType, ok := enumTypeMap[fieldName]; ok {
			return placeholder + "::" + dialect.QuoteID(enumType)
		}
	}
	return placeholder
}

var isoDateTimeRE = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}`)

func serializeValue(value any, dialect *Dialect) any {
	if value == nil {
		return value
	}

	// Handle time.Time
	if t, ok := value.(time.Time); ok {
		if dialect.Name == "mysql" {
			return t.Format("2006-01-02 15:04:05")
		}
		return t.Format(time.RFC3339Nano)
	}

	// JSON: maps and slices need to be stringified
	switch v := value.(type) {
	case map[string]any:
		b, _ := json.Marshal(v)
		return string(b)
	case []any:
		b, _ := json.Marshal(v)
		return string(b)
	}

	// MySQL datetime string conversion
	if s, ok := value.(string); ok && dialect.Name == "mysql" {
		if isoDateTimeRE.MatchString(s) {
			s = strings.Replace(s, "T", " ", 1)
			s = strings.Replace(s, "Z", "", 1)
			// Remove fractional seconds
			if idx := strings.LastIndex(s, "."); idx > 0 {
				s = s[:idx]
			}
			return s
		}
	}

	return value
}
