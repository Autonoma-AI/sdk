package main

import (
	"database/sql"
	"log"
	"os"

	"github.com/autonoma-ai/sdk-go/autonoma"
	"github.com/gin-gonic/gin"
	_ "github.com/lib/pq"
)

func main() {
	// 1. Connect to PostgreSQL
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://autonoma:autonoma@localhost:5432/autonoma_example?sslmode=disable"
	}
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	// Create tables
	if err := createTables(db); err != nil {
		log.Fatal(err)
	}

	// 2. Configure Autonoma
	sharedSecret := os.Getenv("AUTONOMA_SHARED_SECRET")
	if sharedSecret == "" {
		sharedSecret = "my-shared-secret"
	}
	signingSecret := os.Getenv("AUTONOMA_SIGNING_SECRET")
	if signingSecret == "" {
		signingSecret = "my-signing-secret"
	}

	config := &autonoma.HandlerConfig{
		Executor:      autonoma.NewSQLExecutor(db),
		ScopeField:    "organization_id",
		Dialect:       "postgres",
		SharedSecret:  sharedSecret,
		SigningSecret:  signingSecret,
		Auth: func(user map[string]any, ctx autonoma.AuthContext) (*autonoma.AuthResult, error) {
			return &autonoma.AuthResult{
				Extra: map[string]any{
					"headers": map[string]any{
						"Authorization": "Bearer test-token",
					},
				},
			}, nil
		},
	}

	// 3. Set up Gin router
	r := gin.Default()
	r.POST("/api/autonoma", autonoma.GinHandler(config))

	// 4. Start server
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	log.Printf("Server running on http://localhost:%s", port)
	log.Printf("Autonoma endpoint: POST http://localhost:%s/api/autonoma", port)
	r.Run(":" + port)
}

func createTables(db *sql.DB) error {
	schema := `
	CREATE TABLE IF NOT EXISTS organizations (
		id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
		name VARCHAR(255) NOT NULL,
		created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
	);
	CREATE TABLE IF NOT EXISTS users (
		id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
		email VARCHAR(255) NOT NULL UNIQUE,
		name VARCHAR(255) NOT NULL,
		organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id),
		created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
	);
	CREATE TABLE IF NOT EXISTS projects (
		id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
		name VARCHAR(255) NOT NULL,
		organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id),
		created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
	);
	CREATE TABLE IF NOT EXISTS tasks (
		id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
		title VARCHAR(255) NOT NULL,
		status VARCHAR(50) NOT NULL DEFAULT 'todo',
		organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id),
		project_id VARCHAR(36) NOT NULL REFERENCES projects(id),
		assignee_id VARCHAR(36) NOT NULL REFERENCES users(id),
		created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
	);`
	_, err := db.Exec(schema)
	return err
}
