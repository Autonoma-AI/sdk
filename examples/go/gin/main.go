// =============================================================================
// Autonoma SDK — Gin + SQL Example (Hybrid Factories + SQL)
// =============================================================================
// This example shows how to use factories for models with business logic
// (Organization, User) while letting the SDK handle simpler models (Project,
// Task) via raw SQL. This "hybrid" approach gives you the best of both worlds:
// correct business logic where it matters, zero setup where it doesn't.
//
// Factory summary:
//   - Organization: factory with custom create AND teardown (handles external
//     resource cleanup, e.g. Stripe subscription cancellation)
//   - User: factory with custom create only, no teardown (SDK falls back to
//     SQL DELETE, which is fine for users)
//   - Project: no factory — pure SQL INSERT/DELETE
//   - Task: no factory — pure SQL INSERT/DELETE

package main

import (
	"crypto/sha256"
	"database/sql"
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/autonoma-ai/sdk-go/autonoma"
	"github.com/gin-gonic/gin"
	_ "github.com/lib/pq"
)

// ---------------------------------------------------------------------------
// Repository functions
// ---------------------------------------------------------------------------
// These simulate real-world repositories with business logic that raw SQL
// INSERT cannot replicate.

// createOrganization wraps INSERT with business logic.
// In a real app this might generate slugs, set up billing via Stripe,
// create default organization settings, or send a welcome email.
func createOrganization(db *sql.DB, data map[string]any) (map[string]any, error) {
	name, _ := data["name"].(string)

	// Business logic would go here:
	// - Create a Stripe customer
	// - Set up default organization settings
	// - Send a welcome email to the creator

	var id string
	err := db.QueryRow(
		`INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
		name,
	).Scan(&id)
	if err != nil {
		return nil, fmt.Errorf("creating organization: %w", err)
	}

	return map[string]any{"id": id, "name": name}, nil
}

// deleteOrganization handles teardown with business logic cleanup.
// In a real app: cancel Stripe subscription, revoke API keys, etc.
func deleteOrganization(db *sql.DB, id string) error {
	// Business logic would go here:
	// - Cancel Stripe subscription
	// - Revoke API keys
	// - Clean up external resources

	_, err := db.Exec(`DELETE FROM organizations WHERE id = $1`, id)
	return err
}

// createUser wraps INSERT with password hashing and email normalization.
// This is exactly the kind of business logic that raw SQL can't replicate —
// if the User model has a password column, tests need properly hashed values.
func createUser(db *sql.DB, data map[string]any) (map[string]any, error) {
	email, _ := data["email"].(string)
	name, _ := data["name"].(string)
	organizationID, _ := data["organization_id"].(string)

	// Business logic: normalize email, hash a default password
	normalizedEmail := strings.TrimSpace(strings.ToLower(email))
	hashedPassword := fmt.Sprintf("%x", sha256.Sum256([]byte("default-test-password")))
	_ = hashedPassword // In a real app, you'd store this in a password column

	var id string
	err := db.QueryRow(
		`INSERT INTO users (email, name, organization_id) VALUES ($1, $2, $3) RETURNING id`,
		normalizedEmail, name, organizationID,
	).Scan(&id)
	if err != nil {
		return nil, fmt.Errorf("creating user: %w", err)
	}

	return map[string]any{
		"id":              id,
		"email":           normalizedEmail,
		"name":            name,
		"organization_id": organizationID,
	}, nil
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

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

	// 3. Set up handler with hybrid factories
	// Factories let you use your own repository functions to create test data.
	// The SDK still handles scenario resolution, FK ordering, and teardown —
	// but delegates actual creation to your code for models that need it.
	//
	// Models WITHOUT a factory (Project, Task) fall back to raw SQL INSERT,
	// which works fine for simple tables without business logic.
	config := &autonoma.HandlerConfig{
		// Connects the SDK to your database through your ORM (Prisma, Drizzle, SQLAlchemy, etc.)
		Executor: autonoma.NewSQLExecutor(db),
		// The column that scopes all models to a tenant (e.g. organization_id). The SDK uses this to
		// isolate test data and ensure teardown only removes records belonging to the test run.
		ScopeField: "organization_id",
		Dialect:    "postgres",
		// Shared between your server and Autonoma. Used to verify incoming requests via HMAC-SHA256.
		SharedSecret: sharedSecret,
		// Private to your server only. Used to sign the refs token that tracks created records,
		// so teardown can only delete what was created.
		SigningSecret: signingSecret,

		// Custom create/teardown logic for models with business logic (password hashing, slug
		// generation, etc.). Models without a factory fall back to raw SQL INSERT.
		Factories: autonoma.FactoryRegistry{
			// Organization: uses repository which handles slug generation,
			// default settings, external service setup, etc.
			// Has custom teardown for external resource cleanup.
			"Organization": autonoma.FactoryDefinition{
				Create: func(data map[string]any, ctx autonoma.FactoryContext) (map[string]any, error) {
					return createOrganization(db, data)
				},
				Teardown: func(record map[string]any, ctx autonoma.FactoryContext) error {
					return deleteOrganization(db, record["id"].(string))
				},
			},

			// User: uses repository which handles password hashing,
			// email normalization, and other business logic.
			// No Teardown defined — the SDK falls back to SQL DELETE.
			"User": autonoma.FactoryDefinition{
				Create: func(data map[string]any, ctx autonoma.FactoryContext) (map[string]any, error) {
					return createUser(db, data)
				},
			},

			// Project and Task have no factories — they use raw SQL INSERT/DELETE.
			// This is fine because they're simple tables with no business logic.
		},

		// Called after entity creation during `up`. Returns credentials (cookies, headers, tokens)
		// so Autonoma can make authenticated requests as the test user.
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

	// 4. Set up Gin router
	r := gin.Default()
	r.POST("/api/autonoma", autonoma.GinHandler(config))

	// 5. Start server
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
