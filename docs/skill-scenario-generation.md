# Skill: Generating Scenario Data for Autonoma E2E Tests

This document teaches an LLM how to generate valid scenario JSON for the Autonoma SDK. You will generate this data, validate it, and fix errors in a loop until the scenario works against a real database.

---

## 1. What you're generating

A scenario is a JSON object that tells the SDK what database records to create before a test and tear down after. You generate the `entities` section:

```json
{
  "name": "standard",
  "entities": {
    "Organization": {
      "count": 1,
      "fields": { "name": "Acme [{{testRunId}}]", "slug": "acme-{{testRunId}}" }
    },
    "User": {
      "count": 1,
      "fields": { "email": "admin-{{testRunId}}@acme.dev", "name": "Admin" }
    },
    "Member": {
      "count": 1,
      "fields": {
        "userId": "{{refs.User[0].id}}",
        "organizationId": "{{refs.Organization[0].id}}",
        "role": "owner"
      }
    }
  }
}
```

Each entry: a Prisma model name → `{ count, fields }`. The SDK creates them in FK order automatically.

---

## 2. The generation flow

### Step 1: Read the schema

Read `autonoma-schema.json` — the portable description of the database. It has:
- **models**: every table with its fields (name, type, required, hasDefault)
- **edges**: every FK relationship (from → to, localField, nullable)
- **relations**: parent-child mappings (for future nested format)
- **scopeField**: the FK used for test isolation (e.g., `organizationId`)

This file is generated once from the customer's Prisma schema:
```bash
npx autonoma schema convert prisma-dmmf.json --scope-field organizationId -o autonoma-schema.json
```

### Step 2: Generate the scenario JSON

Using the schema, write the entities section. Rules:

**Do include:**
- Every field where `isRequired: true` AND `hasDefault: false` AND `isId: false`
- FK fields as `{{refs.ParentModel[0].id}}` templates
- `{{testRunId}}` in any field with a unique constraint (emails, slugs)

**Do NOT include:**
- Fields with `isId: true` (auto-generated)
- Fields with `hasDefault: true` (DB provides the value)
- The `scopeField` itself (SDK injects it automatically)

**For bulk data** (pagination tests, load tests), use `batch: true`:
```json
"Run": { "count": 10000, "batch": true, "fields": { "testId": "{{refs.Test[0].id}}" } }
```
Batch uses `createMany` (one SQL query). Tradeoff: batch records aren't available in `{{refs.*}}`.

### Step 3: Validate statically

```bash
npx autonoma validate autonoma-schema.json scenario.json
```

This exits 0 if valid, 1 with JSON errors + fix suggestions. Read each error's `fix` field, apply it, re-run.

### Step 4: Dry-run against real DB

Static validation can't catch unique constraints, enum mismatches, or type errors. Use `checkScenario()` in a vitest test with testcontainers:

```typescript
import { checkScenario } from '@autonoma/sdk'

const result = await checkScenario(adapter, scenario)
if (!result.valid) {
  // result.errors[0].message — the Prisma error
  // result.errors[0].fix — what to change
  // result.phase — 'validate' | 'up' | 'down'
}
```

If the check fails:
- **`phase: 'validate'`** — static error. Fix field names, model names, missing fields.
- **`phase: 'up'`** — Prisma rejected the data. Common causes:
  - `Unique constraint failed on (userId, organizationId)` → you're creating multiple records with the same FK combination. Reduce count or ensure uniqueness.
  - `Invalid value for argument 'architecture'` → wrong enum value. Check the Prisma schema.
  - `refs.Model not found` → a dependency model is missing from the scenario.
- **`phase: 'down'`** — teardown failed. Usually means a FK constraint wasn't properly handled.

### Step 5: Fix and retry

Read the error, fix the JSON, go to step 3. Repeat until `result.valid === true`.

---

## 3. Template expressions

| Expression | Type | Use for |
|---|---|---|
| `{{testRunId}}` | string | Unique values across parallel test runs |
| `{{index}}` | number | 0-based index within this model's count |
| `{{index1}}` | number | 1-based index (human-readable) |
| `{{refs.Model[i].field}}` | any | FK references to previously created entities |
| `{{cycle(['a','b','c'])}}` | string | Distributing enum values across instances |
| `{{random.int(a,b)}}` | number | Random integers (prices, quantities) |
| `{{now()}}` | string | ISO timestamps |
| `{{daysAgo(n)}}` | string | Historical timestamps |

**Type preservation**: `"price": "{{random.int(100, 5000)}}"` → number. `"name": "Item {{index1}}"` → string.

---

## 4. Common patterns

### Base (most tests start here)
```json
{
  "Organization": { "count": 1, "fields": { "name": "Org [{{testRunId}}]", "slug": "org-{{testRunId}}" } },
  "User": { "count": 1, "fields": { "email": "admin-{{testRunId}}@test.com", "name": "Admin" } },
  "Member": { "count": 1, "fields": { "userId": "{{refs.User[0].id}}", "organizationId": "{{refs.Organization[0].id}}", "role": "owner" } }
}
```

### Multiple enum variants
```json
"Application": {
  "count": 3,
  "fields": {
    "name": "{{cycle(['Web App','Android App','iOS App'])}}",
    "architecture": "{{cycle(['WEB','ANDROID','IOS'])}}"
  }
}
```

### Bulk for pagination testing
```json
"Run": { "count": 10000, "batch": true, "fields": { "testId": "{{refs.Test[0].id}}" } }
```

### Empty scenario
Just the org + user. Tests empty states and onboarding.

---

## 5. What goes wrong and how to fix it

| Error | Cause | Fix |
|---|---|---|
| `Unique constraint failed on (userId, organizationId)` | Multiple Members with same userId+orgId | Reduce Member count to 1, or use nested format (future) |
| `Unique constraint failed on (slug)` | Two orgs with same slug | Add `{{testRunId}}` to slug |
| `refs.TestGroup not found` | TestGroup not in scenario entities | Add TestGroup to the scenario |
| `refs.Application[5] but only 3 defined` | Index out of bounds | Use index < count |
| `Invalid value for 'architecture'` | Wrong enum value | Check schema for valid enum values |
| `Unknown argument 'organizationId'` | Model doesn't have that field | Remove the field — SDK injects scope field automatically |
| `batch mode — not available in refs` | Another entity references a batch entity | Remove `batch: true` from the referenced entity, or don't reference it |

---

## 6. The three standard scenarios

Every project needs three:

**`standard`** — Realistic org with variety. Enough data to test every filter, status, and category. Entity names are descriptive ("Marketing Website", not "App 1"). 1 of each type at minimum, more where needed for filtering/pagination.

**`empty`** — Org + user only. Zero apps, zero tests, zero runs. Tests empty state UI and onboarding flows.

**`large`** — High-volume data exceeding pagination thresholds. Use `batch: true` for runs (10k+), folders (40+), tags (30+). Tests pagination, filter performance, bulk operations.
