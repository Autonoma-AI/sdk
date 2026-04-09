package autonoma

import (
	"context"
	"fmt"
	"regexp"
	"strings"
)

type introspectConfig struct {
	ScopeField    string
	Schema        string
	TableNameMap  map[string]string
	ExcludeTables []string
}

// IntrospectDatabase introspects a database via information_schema to build SchemaInfo.
func IntrospectDatabase(ctx context.Context, executor SQLExecutor, dialect *Dialect, cfg introspectConfig) (*IntrospectionResult, error) {
	dbSchema := cfg.Schema
	if dbSchema == "" {
		if dialect.Name == "mysql" {
			return nil, fmt.Errorf("MySQL requires a schema (database name). Pass it via config.Schema or HandlerConfig.DBSchema")
		}
		dbSchema = "public"
	}

	excludeSet := make(map[string]bool)
	if len(cfg.ExcludeTables) > 0 {
		for _, t := range cfg.ExcludeTables {
			excludeSet[t] = true
		}
	} else {
		excludeSet["_prisma_migrations"] = true
	}

	// Run all introspection queries
	tableRows, err := executor.Query(ctx, dialect.TablesSQL(dbSchema))
	if err != nil {
		return nil, fmt.Errorf("introspect tables: %w", err)
	}
	columnRows, err := executor.Query(ctx, dialect.ColumnsSQL(dbSchema))
	if err != nil {
		return nil, fmt.Errorf("introspect columns: %w", err)
	}
	pkRows, err := executor.Query(ctx, dialect.PrimaryKeysSQL(dbSchema))
	if err != nil {
		return nil, fmt.Errorf("introspect primary keys: %w", err)
	}
	fkRows, err := executor.Query(ctx, dialect.ForeignKeysSQL(dbSchema))
	if err != nil {
		return nil, fmt.Errorf("introspect foreign keys: %w", err)
	}
	enumRows, err := executor.Query(ctx, dialect.EnumsSQL(dbSchema))
	if err != nil {
		return nil, fmt.Errorf("introspect enums: %w", err)
	}

	// Normalize keys
	tableRows = normalizeKeys(tableRows)
	columnRows = normalizeKeys(columnRows)
	pkRows = normalizeKeys(pkRows)
	fkRows = normalizeKeys(fkRows)
	enumRows = normalizeKeys(enumRows)

	// Build enum lookup
	enumValues := make(map[string][]string)
	for _, row := range enumRows {
		enumName := asString(row["enum_name"])
		if enumName == "" {
			continue
		}
		enumValues[enumName] = append(enumValues[enumName], asString(row["enum_value"]))
	}

	// For MySQL, parse inline enums
	if dialect.Name == "mysql" {
		for _, col := range columnRows {
			parsed := parseMySQLEnum(asString(col["udt_name"]))
			if parsed != nil {
				key := asString(col["table_name"]) + "." + asString(col["column_name"])
				enumValues[key] = parsed
			}
		}
	}

	// Build PK lookup
	pksByTable := make(map[string]map[string]bool)
	for _, row := range pkRows {
		tbl := asString(row["table_name"])
		col := asString(row["column_name"])
		if pksByTable[tbl] == nil {
			pksByTable[tbl] = make(map[string]bool)
		}
		pksByTable[tbl][col] = true
	}

	// Build table name mapping
	tableMap := make(map[string]string)
	reverseTableMap := make(map[string]string)

	if cfg.TableNameMap != nil {
		for model, dbTable := range cfg.TableNameMap {
			tableMap[model] = dbTable
			reverseTableMap[dbTable] = model
		}
	}

	for _, row := range tableRows {
		dbTable := asString(row["table_name"])
		if excludeSet[dbTable] {
			continue
		}
		if _, exists := reverseTableMap[dbTable]; exists {
			continue
		}
		modelName := snakeToPascal(dbTable)
		tableMap[modelName] = dbTable
		reverseTableMap[dbTable] = modelName
	}

	// Group columns by table
	columnsByTable := make(map[string][]map[string]any)
	for _, row := range columnRows {
		tbl := asString(row["table_name"])
		columnsByTable[tbl] = append(columnsByTable[tbl], row)
	}

	// Build models, column maps, enum type maps
	var models []ModelInfo
	columnMaps := make(map[string]map[string]string)
	enumTypeMaps := make(map[string]map[string]string)

	for modelName, dbTable := range tableMap {
		cols := columnsByTable[dbTable]
		pks := pksByTable[dbTable]
		colMap := make(map[string]string)
		var fields []FieldInfo

		for _, col := range cols {
			colName := asString(col["column_name"])
			fieldName := snakeToCamel(colName)
			colMap[fieldName] = colName

			dataType := asString(col["data_type"])
			udtName := asString(col["udt_name"])

			var enumVals []string
			if dialect.Name == "mysql" {
				enumVals = enumValues[dbTable+"."+colName]
			} else {
				enumVals = enumValues[udtName]
			}

			var fieldType string
			if enumVals != nil {
				fieldType = "enum(" + strings.Join(enumVals, ",") + ")"
			} else {
				fieldType = mapDataType(dataType, udtName, dialect.Name)
			}

			// Track Postgres types that need explicit parameter casting
			if dialect.Name == "postgres" {
				if enumVals != nil {
					if enumTypeMaps[modelName] == nil {
						enumTypeMaps[modelName] = make(map[string]string)
					}
					enumTypeMaps[modelName][fieldName] = udtName
				} else if dataType == "jsonb" || udtName == "jsonb" || dataType == "json" || udtName == "json" {
					if enumTypeMaps[modelName] == nil {
						enumTypeMaps[modelName] = make(map[string]string)
					}
					jsonType := "jsonb"
					if dataType == "json" || udtName == "json" {
						jsonType = "json"
					}
					enumTypeMaps[modelName][fieldName] = jsonType
				} else if strings.Contains(dataType, "timestamp") || udtName == "timestamptz" || udtName == "timestamp" {
					if enumTypeMaps[modelName] == nil {
						enumTypeMaps[modelName] = make(map[string]string)
					}
					enumTypeMaps[modelName][fieldName] = udtName
				}
			}

			fields = append(fields, FieldInfo{
				Name:       fieldName,
				Type:       fieldType,
				IsRequired: asString(col["is_nullable"]) == "NO",
				IsId:       pks[colName],
				HasDefault: col["column_default"] != nil && asString(col["column_default"]) != "",
			})
		}

		columnMaps[modelName] = colMap
		models = append(models, ModelInfo{
			Name:      modelName,
			TableName: dbTable,
			Fields:    fields,
		})
	}

	// Build FK edges
	var edges []FKEdge
	for _, fk := range fkRows {
		fromTable := asString(fk["from_table"])
		toTable := asString(fk["to_table"])
		fromModel := reverseTableMap[fromTable]
		toModel := reverseTableMap[toTable]
		if fromModel == "" || toModel == "" {
			continue
		}

		fromColMap := columnMaps[fromModel]
		toColMap := columnMaps[toModel]
		localField := reverseGetMap(fromColMap, asString(fk["from_column"]))
		if localField == "" {
			localField = asString(fk["from_column"])
		}
		foreignField := reverseGetMap(toColMap, asString(fk["to_column"]))
		if foreignField == "" {
			foreignField = asString(fk["to_column"])
		}

		edges = append(edges, FKEdge{
			From:         fromModel,
			To:           toModel,
			LocalField:   localField,
			ForeignField: foreignField,
			Nullable:     asString(fk["is_nullable"]) == "YES",
		})
	}

	// Build relations from FK edges
	var relations []SchemaRelation
	for _, edge := range edges {
		fromDbTable := tableMap[edge.From]
		fromColMap := columnMaps[edge.From]
		fkDbCol := fromColMap[edge.LocalField]
		if fkDbCol == "" {
			fkDbCol = edge.LocalField
		}
		fromPks := pksByTable[fromDbTable]
		isOneToOne := len(fromPks) == 1 && fromPks[fkDbCol]

		var parentField string
		if isOneToOne {
			parentField = lowerFirst(edge.From)
		} else {
			parentField = pluralCamelCase(edge.From)
		}

		// Parent-side
		relations = append(relations, SchemaRelation{
			ParentModel: edge.To,
			ChildModel:  edge.From,
			ParentField: parentField,
			ChildField:  edge.LocalField,
		})

		// Child-side
		relations = append(relations, SchemaRelation{
			ParentModel: edge.From,
			ChildModel:  edge.To,
			ParentField: lowerFirst(edge.To),
			ChildField:  edge.LocalField,
		})
	}

	return &IntrospectionResult{
		Schema: SchemaInfo{
			Models:     models,
			Edges:      edges,
			Relations:  relations,
			ScopeField: cfg.ScopeField,
		},
		TableMap:     tableMap,
		ColumnMaps:   columnMaps,
		EnumTypeMaps: enumTypeMaps,
	}, nil
}

// Name mapping utilities

func snakeToPascal(str string) string {
	parts := strings.Split(str, "_")
	var result strings.Builder
	for _, p := range parts {
		if len(p) > 0 {
			result.WriteString(strings.ToUpper(p[:1]))
			result.WriteString(p[1:])
		}
	}
	return result.String()
}

func snakeToCamel(str string) string {
	pascal := snakeToPascal(str)
	if len(pascal) == 0 {
		return pascal
	}
	return strings.ToLower(pascal[:1]) + pascal[1:]
}

var mysqlEnumRE = regexp.MustCompile(`(?i)^enum\((.+)\)$`)

func parseMySQLEnum(columnType string) []string {
	if columnType == "" {
		return nil
	}
	m := mysqlEnumRE.FindStringSubmatch(columnType)
	if m == nil {
		return nil
	}
	parts := strings.Split(m[1], ",")
	result := make([]string, len(parts))
	for i, v := range parts {
		v = strings.TrimSpace(v)
		v = strings.Trim(v, "'")
		result[i] = v
	}
	return result
}

func mapDataType(dataType, udtName, dialectName string) string {
	dt := strings.ToLower(dataType)

	// Integer types
	switch dt {
	case "integer", "smallint", "bigint", "int", "mediumint", "tinyint":
		return "Int"
	}
	// Float types
	switch dt {
	case "numeric", "real", "double precision", "float", "double", "decimal":
		return "Float"
	}
	// Boolean
	if dt == "boolean" || (dt == "tinyint" && strings.HasPrefix(strings.ToLower(udtName), "tinyint(1)")) {
		return "Boolean"
	}
	// String types
	switch dt {
	case "text", "character varying", "character", "varchar", "char", "mediumtext", "longtext", "tinytext":
		return "String"
	}
	// DateTime
	switch dt {
	case "timestamp with time zone", "timestamp without time zone", "date", "time", "datetime", "timestamp":
		return "DateTime"
	}
	// JSON
	if dt == "json" || dt == "jsonb" {
		return "Json"
	}
	// UUID
	if dt == "uuid" {
		return "String"
	}
	// Binary
	switch dt {
	case "bytea", "blob", "mediumblob", "longblob", "tinyblob", "binary", "varbinary":
		return "Bytes"
	}
	// Postgres user-defined
	if dt == "user-defined" && dialectName == "postgres" {
		return udtName
	}
	// MySQL enum/set
	if dt == "enum" || dt == "set" {
		return udtName
	}
	return dataType
}

func lowerFirst(str string) string {
	if len(str) == 0 {
		return str
	}
	return strings.ToLower(str[:1]) + str[1:]
}

func pluralCamelCase(modelName string) string {
	camel := lowerFirst(modelName)
	return pluralize(camel)
}

func pluralize(str string) string {
	if strings.HasSuffix(str, "s") || strings.HasSuffix(str, "x") || strings.HasSuffix(str, "z") ||
		strings.HasSuffix(str, "ch") || strings.HasSuffix(str, "sh") {
		return str + "es"
	}
	if strings.HasSuffix(str, "y") && len(str) > 1 && !isVowel(str[len(str)-2]) {
		return str[:len(str)-1] + "ies"
	}
	return str + "s"
}

func isVowel(ch byte) bool {
	return strings.ContainsRune("aeiouAEIOU", rune(ch))
}

func normalizeKeys(rows []map[string]any) []map[string]any {
	result := make([]map[string]any, len(rows))
	for i, row := range rows {
		normalized := make(map[string]any, len(row))
		for k, v := range row {
			normalized[strings.ToLower(k)] = v
		}
		result[i] = normalized
	}
	return result
}

func reverseGetMap(m map[string]string, dbName string) string {
	for key, val := range m {
		if val == dbName {
			return key
		}
	}
	return ""
}

func asString(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprintf("%v", v)
}
