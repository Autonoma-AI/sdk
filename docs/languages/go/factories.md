# Writing factories (Go)

A factory tells the SDK how to create and delete one model using your own code. You register one factory per model the platform can create, keyed by model name, and pass them all to the handler as `Factories`. This page is the exact contract; read it before writing any.

## The shape

A factory is a `FactoryDefinition` struct with function fields. Build one with a struct literal or with the `DefineFactory` constructor (which validates and panics early on misconfiguration).

```go
// factories/organization.go
package factories

import (
	"reflect"

	"github.com/autonoma-ai/sdk/sdks/go/autonoma"
	"myapp/db"
)

type OrganizationInput struct {
	Name string `json:"name"`
	Slug string `json:"slug"`
}

var Organization = autonoma.FactoryDefinition{
	InputStruct: reflect.TypeOf(OrganizationInput{}),
	Create: func(input interface{}, ctx autonoma.FactoryContext) (map[string]any, error) {
		in := input.(*OrganizationInput)
		org, err := db.CreateOrganization(in.Name, in.Slug) // your real creation code
		if err != nil {
			return nil, err
		}
		return map[string]any{"id": org.ID, "name": org.Name}, nil
	},
	Teardown: func(record interface{}, ctx autonoma.FactoryContext) error {
		rec := record.(map[string]any)
		return db.DeleteOrganization(rec["id"].(string))
	},
}
```

The equivalent with the constructor - arguments are positional in this order: `create`, `inputStruct`, `teardown`, `refStruct`. Pass `nil` for `teardown` or `refStruct` when unused:

```go
// factories/organization_alt.go
var Organization = autonoma.DefineFactory(
	func(input interface{}, ctx autonoma.FactoryContext) (map[string]any, error) {
		in := input.(*OrganizationInput)
		org, err := db.CreateOrganization(in.Name, in.Slug)
		if err != nil {
			return nil, err
		}
		return map[string]any{"id": org.ID, "name": org.Name}, nil
	},
	reflect.TypeOf(OrganizationInput{}),
	nil, // teardown
	nil, // refStruct
)
```

`DefineFactory` panics at construction if `create` is nil or `inputStruct` is nil or not a struct type. The struct-literal form is not validated until the first `discover` or `up` request.

## InputStruct (required)

A `reflect.Type` for a Go struct describing the fields this model accepts in the create payload. Get it with `reflect.TypeOf(MyInput{})`. It does two jobs:

1. Before calling `Create`, the SDK marshals the resolved field map to JSON and unmarshals it into a fresh pointer to this struct. A type mismatch fails the request with `INVALID_BODY`. (Missing fields become Go zero values - there is no hard "required" enforcement, unlike a schema validator.)
2. The SDK derives the discover schema from it - there is no database introspection, so this struct is how the platform learns your model exists and what fields it has.

Field names on the wire come from the `json` struct tag; without a tag the SDK lowercases the first letter of the Go field name. Type strings in the discover schema are mapped from Go types:

| Go type | Discover type |
|---------|---------------|
| `string` | `string` |
| `int`, `int64`, ... | `integer` |
| `float32`, `float64` | `number` |
| `bool` | `boolean` |
| `time.Time` | `timestamp` |
| `uuid.UUID` | `uuid` |
| slice, map, array, struct | `json` |

A field is reported as optional (`hasDefault: true`, `isRequired: false`) when it is a pointer type or its `json` tag contains `omitempty`. Every model also gets a synthetic `id` field (`isId: true`). The `tableName` in the schema is the model key converted to snake_case; it is cosmetic.

**Include every foreign key in the input struct, including the scope field.** By the time `Create` runs, the SDK has already resolved every `_ref` to the real ID of the referenced record, so a FK arrives as a plain value:

```go
// factories/user.go
type UserInput struct {
	Name           string `json:"name"`
	Email          string `json:"email"`
	OrganizationID string `json:"organizationId"` // arrives as the real Organization id, not a _ref
}

var User = autonoma.FactoryDefinition{
	InputStruct: reflect.TypeOf(UserInput{}),
	Create: func(input interface{}, ctx autonoma.FactoryContext) (map[string]any, error) {
		in := input.(*UserInput)
		u, err := db.SignUpUser(in.Name, in.Email, in.OrganizationID) // reuse your real signup code
		if err != nil {
			return nil, err
		}
		return map[string]any{"id": u.ID, "email": u.Email}, nil
	},
}
```

## Create

Creates exactly one record and returns it.

- `input interface{}` - a pointer to a freshly populated instance of your `InputStruct`. Cast it: `in := input.(*UserInput)`. FK fields are already real IDs.
- `ctx autonoma.FactoryContext` - `{ Refs, ScenarioName, TestRunID }`. `Refs` (`map[string][]map[string]any`) holds everything created so far this run, keyed by model, if you need to look something up.
- **Return value** - a `map[string]any` that must include at least the primary key `"id"`. If it is `nil` or has no `"id"`, the SDK fails the request with `FACTORY_MISSING_PK`. Everything you return is stored in `Refs`, passed to the auth callback, and later handed to `Teardown` - so return whatever teardown or auth will need (typically the id, plus fields like `email`).

Reuse your application's real creation path (`SignUpUser`, `CreateOrganization`, a service method). That is the entire point: the test user gets the same password hash, defaults, and side effects a real user would. The SDK ships no database connection - your factory reaches for its own GORM, `sqlx`, `pgx`, or `database/sql` handle.

## Teardown (optional)

Deletes one record. The SDK calls it once per created record, in reverse dependency order, during `down`.

- `record interface{}` - by default this is the raw `map[string]any` your `Create` returned; cast it with `record.(map[string]any)`. If you set `RefStruct`, it is instead a pointer to that struct (see below).
- Return an `error` to abort teardown; the handler propagates it.
- If you leave `Teardown` nil, the model is never deleted on `down`. Provide it for every model you create, or those rows leak.

```go
// factories/user_teardown.go
Teardown: func(record interface{}, ctx autonoma.FactoryContext) error {
	rec := record.(map[string]any)
	return db.DeleteUser(rec["id"].(string))
},
```

## RefStruct (optional)

A `reflect.Type` for the record `Create` returns. When set, the SDK marshals the stored record to JSON and unmarshals it into a fresh pointer to this struct before calling `Teardown`, so `record` arrives typed and you skip the `map[string]any` casts:

```go
// factories/user_refstruct.go
type UserRef struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}

var User = autonoma.FactoryDefinition{
	InputStruct: reflect.TypeOf(UserInput{}),
	RefStruct:   reflect.TypeOf(UserRef{}),
	Create: func(input interface{}, ctx autonoma.FactoryContext) (map[string]any, error) {
		in := input.(*UserInput)
		u, err := db.SignUpUser(in.Name, in.Email, in.OrganizationID)
		if err != nil {
			return nil, err
		}
		return map[string]any{"id": u.ID, "email": u.Email}, nil
	},
	Teardown: func(record interface{}, ctx autonoma.FactoryContext) error {
		ref := record.(*UserRef) // typed, no map casts
		return db.DeleteUser(ref.ID)
	},
}
```

## Registering factories

Collect every factory into a `FactoryRegistry` (a `map[string]autonoma.FactoryDefinition`) keyed by model name - the key must match the model name the platform sends in `create`:

```go
// factories/registry.go
package factories

import "github.com/autonoma-ai/sdk/sdks/go/autonoma"

var Registry = autonoma.FactoryRegistry{
	"Organization": Organization,
	"User":         User,
	"Member":       Member,
}
```

Pass that map as `Factories` when you build the handler config (see `implement.md`). Every model that appears in a scenario must have an entry here, or the request fails with `INVALID_BODY` (`no factory registered for model "..."`).
