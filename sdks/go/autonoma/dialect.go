package autonoma

import (
	"fmt"
	"strings"
)

// Dialect abstracts SQL differences between database engines.
type Dialect struct {
	Name              string
	Param             func(index int) string
	QuoteID           func(name string) string
	SupportsReturning bool
	TablesSQL         func(schema string) string
	ColumnsSQL        func(schema string) string
	PrimaryKeysSQL    func(schema string) string
	ForeignKeysSQL    func(schema string) string
	EnumsSQL          func(schema string) string
}

func replaceSchema(template, schema string) string {
	return strings.ReplaceAll(template, "{{schema}}", schema)
}

var PostgresDialect = Dialect{
	Name:              "postgres",
	Param:             func(i int) string { return fmt.Sprintf("$%d", i) },
	QuoteID:           func(name string) string { return `"` + name + `"` },
	SupportsReturning: true,
	TablesSQL:         func(schema string) string { return replaceSchema(POSTGRES_TABLES, schema) },
	ColumnsSQL:        func(schema string) string { return replaceSchema(POSTGRES_COLUMNS, schema) },
	PrimaryKeysSQL:    func(schema string) string { return replaceSchema(POSTGRES_PRIMARY_KEYS, schema) },
	ForeignKeysSQL:    func(schema string) string { return replaceSchema(POSTGRES_FOREIGN_KEYS, schema) },
	EnumsSQL:          func(schema string) string { return replaceSchema(POSTGRES_ENUMS, schema) },
}

var MySQLDialect = Dialect{
	Name:              "mysql",
	Param:             func(_ int) string { return "?" },
	QuoteID:           func(name string) string { return "`" + name + "`" },
	SupportsReturning: false,
	TablesSQL:         func(schema string) string { return replaceSchema(MYSQL_TABLES, schema) },
	ColumnsSQL:        func(schema string) string { return replaceSchema(MYSQL_COLUMNS, schema) },
	PrimaryKeysSQL:    func(schema string) string { return replaceSchema(MYSQL_PRIMARY_KEYS, schema) },
	ForeignKeysSQL:    func(schema string) string { return replaceSchema(MYSQL_FOREIGN_KEYS, schema) },
	EnumsSQL:          func(_ string) string { return MYSQL_ENUMS },
}

// GetDialect returns the dialect for the given name. Defaults to "postgres".
func GetDialect(name string) (*Dialect, error) {
	switch name {
	case "", "postgres":
		d := PostgresDialect
		return &d, nil
	case "mysql":
		d := MySQLDialect
		return &d, nil
	default:
		return nil, fmt.Errorf("dialect %q is not yet supported. Currently only \"postgres\" and \"mysql\" are available", name)
	}
}
