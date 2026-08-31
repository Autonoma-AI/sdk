// =============================================================================
// Autonoma SDK — Gin Example (Factory-driven)
// =============================================================================
// The SDK is factory-driven: every model the dashboard can create has a
// registered factory whose InputStruct (a Go struct) drives both validation
// and the discover schema. There is no SQL introspection, no SQL fallback,
// and no executor — your factories call whatever services your app already has.

package main

import (
	"crypto/sha256"
	"database/sql"
	"fmt"
	"log"
	"os"
	"reflect"
	"strings"

	"github.com/autonoma-ai/sdk/sdks/go/v2/autonoma"
	"github.com/gin-gonic/gin"
	_ "github.com/lib/pq"
)

// ---------------------------------------------------------------------------
// Input structs — drive both validation and discover schema
// ---------------------------------------------------------------------------

type OrganizationInput struct {
	Name string `json:"name"`
}

type UserInput struct {
	Email          string `json:"email"`
	Name           string `json:"name"`
	OrganizationID string `json:"organization_id"`
}

// ---------------------------------------------------------------------------
// Repository functions (free functions style)
// ---------------------------------------------------------------------------

func createOrganization(db *sql.DB, input *OrganizationInput) (map[string]any, error) {
	var id string
	err := db.QueryRow(
		`INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
		input.Name,
	).Scan(&id)
	if err != nil {
		return nil, fmt.Errorf("creating organization: %w", err)
	}
	return map[string]any{"id": id, "name": input.Name}, nil
}

func deleteOrganization(db *sql.DB, id string) error {
	_, err := db.Exec(`DELETE FROM organizations WHERE id = $1`, id)
	return err
}

func createUser(db *sql.DB, input *UserInput) (map[string]any, error) {
	normalizedEmail := strings.TrimSpace(strings.ToLower(input.Email))
	hashedPassword := fmt.Sprintf("%x", sha256.Sum256([]byte("default-test-password")))
	_ = hashedPassword

	var id string
	err := db.QueryRow(
		`INSERT INTO users (email, name, organization_id) VALUES ($1, $2, $3) RETURNING id`,
		normalizedEmail, input.Name, input.OrganizationID,
	).Scan(&id)
	if err != nil {
		return nil, fmt.Errorf("creating user: %w", err)
	}

	return map[string]any{
		"id":              id,
		"email":           normalizedEmail,
		"name":            input.Name,
		"organization_id": input.OrganizationID,
	}, nil
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

func main() {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://autonoma:autonoma@localhost:5432/autonoma_example?sslmode=disable"
	}
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	if err := createTables(db); err != nil {
		log.Fatal(err)
	}

	sharedSecret := os.Getenv("AUTONOMA_SHARED_SECRET")
	if sharedSecret == "" {
		sharedSecret = "my-shared-secret"
	}
	signingSecret := os.Getenv("AUTONOMA_SIGNING_SECRET")
	if signingSecret == "" {
		signingSecret = "my-signing-secret"
	}

	config := &autonoma.HandlerConfig{
		ScopeField:    "organization_id",
		SharedSecret:  sharedSecret,
		SigningSecret: signingSecret,

		// Every model the dashboard can create needs a factory.
		// The factory's InputStruct drives both validation and discover.
		Factories: autonoma.FactoryRegistry{
			"Organization": autonoma.DefineFactory(autonoma.FactoryOpts{
				InputStruct: reflect.TypeOf(OrganizationInput{}),
				Create: func(data any, ctx autonoma.FactoryContext) (map[string]any, error) {
					input := data.(*OrganizationInput)
					return createOrganization(db, input)
				},
				Teardown: func(record map[string]any, ctx autonoma.FactoryContext) error {
					return deleteOrganization(db, record["id"].(string))
				},
			}),

			// data is automatically unmarshalled into *UserInput
			"User": autonoma.DefineFactory(autonoma.FactoryOpts{
				InputStruct: reflect.TypeOf(UserInput{}),
				Create: func(data any, ctx autonoma.FactoryContext) (map[string]any, error) {
					input := data.(*UserInput)
					return createUser(db, input)
				},
			}),
		},

		Auth: func(user map[string]any, ctx autonoma.AuthContext) (*autonoma.AuthResult, error) {
			return &autonoma.AuthResult{
				Extra: map[string]any{
					"headers": map[string]any{"Authorization": "Bearer test-token"},
				},
			}, nil
		},
	}

	r := gin.Default()
	r.POST("/api/autonoma", autonoma.GinHandler(config))

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
	);`
	_, err := db.Exec(schema)
	return err
}
