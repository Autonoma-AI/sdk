package autonoma

import (
	"reflect"
	"strings"
	"time"

	"github.com/google/uuid"
)

// goTypeToSDKType maps a Go reflect.Type to the SDK's coarse type string.
func goTypeToSDKType(t reflect.Type) string {
	// Unwrap pointer types.
	for t.Kind() == reflect.Ptr {
		t = t.Elem()
	}

	// Check well-known types first.
	if t == reflect.TypeOf(time.Time{}) {
		return "timestamp"
	}
	if t == reflect.TypeOf(uuid.UUID{}) {
		return "uuid"
	}

	switch t.Kind() {
	case reflect.Bool:
		return "boolean"
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return "integer"
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return "integer"
	case reflect.Float32, reflect.Float64:
		return "number"
	case reflect.String:
		return "string"
	case reflect.Slice, reflect.Array, reflect.Map, reflect.Struct:
		return "json"
	default:
		return "string"
	}
}

// fieldName returns the JSON field name for a struct field.
// Uses the json struct tag if present, otherwise lowercases the first char.
func fieldName(f reflect.StructField) string {
	tag := f.Tag.Get("json")
	if tag != "" {
		name := strings.Split(tag, ",")[0]
		if name != "" && name != "-" {
			return name
		}
		if name == "-" {
			return ""
		}
	}
	// Fall back to lowercased first char of field name.
	if len(f.Name) == 0 {
		return ""
	}
	return strings.ToLower(f.Name[:1]) + f.Name[1:]
}

// isFieldRequired returns true if the field has no default value capability.
// Pointer types and types with the "omitempty" json tag are considered optional.
func isFieldRequired(f reflect.StructField) bool {
	tag := f.Tag.Get("json")
	if strings.Contains(tag, "omitempty") {
		return false
	}
	if f.Type.Kind() == reflect.Ptr {
		return false
	}
	return true
}

// modelToFields walks a Go struct's fields to produce a list of FieldInfo.
// Every model gets a synthetic "id" field at the head of the list.
func modelToFields(inputStruct reflect.Type) []FieldInfo {
	// Unwrap pointer.
	for inputStruct.Kind() == reflect.Ptr {
		inputStruct = inputStruct.Elem()
	}

	fields := []FieldInfo{
		{
			Name:       "id",
			Type:       "string",
			IsRequired: false,
			IsId:       true,
			HasDefault: true,
		},
	}

	if inputStruct.Kind() != reflect.Struct {
		return fields
	}

	for i := 0; i < inputStruct.NumField(); i++ {
		f := inputStruct.Field(i)
		// Skip unexported fields.
		if !f.IsExported() {
			continue
		}
		name := fieldName(f)
		if name == "" {
			continue
		}

		hasDefault := f.Type.Kind() == reflect.Ptr || strings.Contains(f.Tag.Get("json"), "omitempty")

		fields = append(fields, FieldInfo{
			Name:       name,
			Type:       goTypeToSDKType(f.Type),
			IsRequired: isFieldRequired(f),
			IsId:       false,
			HasDefault: hasDefault,
		})
	}

	return fields
}

// camelToSnake converts "OrgMember" to "org_member" for cosmetic tableName.
func camelToSnake(name string) string {
	var out []byte
	for i, ch := range name {
		if ch >= 'A' && ch <= 'Z' && i > 0 && name[i-1] >= 'a' && name[i-1] <= 'z' {
			out = append(out, '_')
		}
		out = append(out, byte(ch+32*(rune('A')^ch)>>31&0)) // lowercase
	}
	return strings.ToLower(string(out))
}

// BuildSchemaFromFactories builds the SDK's discover-time schema from registered factories.
func BuildSchemaFromFactories(factories FactoryRegistry, scopeField string) (*SchemaInfo, error) {
	var models []ModelInfo

	for entity, factory := range factories {
		if factory.InputStruct == nil {
			return nil, &AutonomaError{
				Message: "Factory \"" + entity + "\" has no InputStruct. Every factory must declare a Go struct type in InputStruct.",
				Code:    "INTERNAL_ERROR",
				Status:  500,
			}
		}
		models = append(models, ModelInfo{
			Name:      entity,
			TableName: camelToSnake(entity),
			Fields:    modelToFields(factory.InputStruct),
		})
	}

	return &SchemaInfo{
		Models:     models,
		Edges:      []FKEdge{},
		Relations:  []SchemaRelation{},
		ScopeField: scopeField,
	}, nil
}

// SchemaToWire serializes a SchemaInfo to the JSON shape the dashboard expects.
func SchemaToWire(schema *SchemaInfo) map[string]any {
	models := make([]map[string]any, len(schema.Models))
	for i, m := range schema.Models {
		fields := make([]map[string]any, len(m.Fields))
		for j, f := range m.Fields {
			fields[j] = map[string]any{
				"name":       f.Name,
				"type":       f.Type,
				"isRequired": f.IsRequired,
				"isId":       f.IsId,
				"hasDefault": f.HasDefault,
			}
		}
		models[i] = map[string]any{
			"name":      m.Name,
			"tableName": m.TableName,
			"fields":    fields,
		}
	}

	edges := make([]map[string]any, len(schema.Edges))
	for i, e := range schema.Edges {
		edges[i] = map[string]any{
			"from":         e.From,
			"to":           e.To,
			"localField":   e.LocalField,
			"foreignField": e.ForeignField,
			"nullable":     e.Nullable,
		}
	}

	relations := make([]map[string]any, len(schema.Relations))
	for i, r := range schema.Relations {
		relations[i] = map[string]any{
			"parentModel": r.ParentModel,
			"childModel":  r.ChildModel,
			"parentField": r.ParentField,
			"childField":  r.ChildField,
		}
	}

	return map[string]any{
		"models":     models,
		"edges":      edges,
		"relations":  relations,
		"scopeField": schema.ScopeField,
	}
}
