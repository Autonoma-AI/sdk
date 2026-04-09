package autonoma

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// sqlDBExecutor wraps *sql.DB to implement SQLExecutor.
type sqlDBExecutor struct {
	db *sql.DB
}

// sqlTxExecutor wraps *sql.Tx to implement SQLExecutor.
type sqlTxExecutor struct {
	tx *sql.Tx
}

// NewSQLExecutor creates a SQLExecutor from a standard *sql.DB connection.
//
// Usage:
//
//	db, _ := sql.Open("postgres", connString)
//	executor := autonoma.NewSQLExecutor(db)
func NewSQLExecutor(db *sql.DB) SQLExecutor {
	return &sqlDBExecutor{db: db}
}

func (e *sqlDBExecutor) Query(ctx context.Context, query string, params ...any) ([]map[string]any, error) {
	if isExecStatement(query) {
		_, err := e.db.ExecContext(ctx, query, params...)
		if err != nil {
			return nil, err
		}
		return []map[string]any{}, nil
	}
	rows, err := e.db.QueryContext(ctx, query, params...)
	if err != nil {
		return nil, err
	}
	return scanRows(rows)
}

func (e *sqlDBExecutor) Transaction(ctx context.Context, fn func(tx SQLExecutor) error) error {
	tx, err := e.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}

	txExec := &sqlTxExecutor{tx: tx}
	if err := fn(txExec); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

func (e *sqlTxExecutor) Query(ctx context.Context, query string, params ...any) ([]map[string]any, error) {
	if isExecStatement(query) {
		_, err := e.tx.ExecContext(ctx, query, params...)
		if err != nil {
			return nil, err
		}
		return []map[string]any{}, nil
	}
	rows, err := e.tx.QueryContext(ctx, query, params...)
	if err != nil {
		return nil, err
	}
	return scanRows(rows)
}

func (e *sqlTxExecutor) Transaction(ctx context.Context, fn func(tx SQLExecutor) error) error {
	// Nested transactions — just run the function in the same transaction
	return fn(e)
}

// isExecStatement returns true for INSERT/UPDATE/DELETE statements that don't return rows.
// Statements with RETURNING clauses are treated as queries since they return result sets.
func isExecStatement(query string) bool {
	trimmed := strings.TrimSpace(strings.ToUpper(query))
	isWrite := strings.HasPrefix(trimmed, "INSERT") ||
		strings.HasPrefix(trimmed, "UPDATE") ||
		strings.HasPrefix(trimmed, "DELETE")
	if !isWrite {
		return false
	}
	return !strings.Contains(trimmed, "RETURNING")
}

// scanRows converts sql.Rows into a slice of maps.
func scanRows(rows *sql.Rows) ([]map[string]any, error) {
	defer rows.Close()

	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}

	var result []map[string]any
	for rows.Next() {
		values := make([]any, len(cols))
		valuePtrs := make([]any, len(cols))
		for i := range values {
			valuePtrs[i] = &values[i]
		}

		if err := rows.Scan(valuePtrs...); err != nil {
			return nil, err
		}

		row := make(map[string]any, len(cols))
		for i, col := range cols {
			val := values[i]
			// Convert []byte to string for readability
			if b, ok := val.([]byte); ok {
				row[col] = string(b)
			} else {
				row[col] = val
			}
		}
		result = append(result, row)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("row iteration error: %w", err)
	}

	if result == nil {
		result = []map[string]any{}
	}
	return result, nil
}
