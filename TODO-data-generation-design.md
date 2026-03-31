# Data Generation Design — Investigation & Proposal

## Problem Evolution

### Attempt 1: LLM generates full JSON payload (data + schema)
- LLM hallucinates field names, relationships, data types
- Schema drift: LLM's model of the DB diverges from reality
- **Killed because:** too much for the LLM to get right at once

### Attempt 2: LLM calls functions that use Faker
- Generate per-model factory functions, LLM invokes them
- Full flexibility: any format, casing, regex, transforms
- **Open questions:** where do these functions live? Do we run them in a container before tests? Who manages the runtime?

### Attempt 3: DSL on the client side (current approach)
- JSON scenario with template expressions (`{{random.int()}}`, `{{cycle([...])}}`, `{{testRunId}}`)
- SDK resolves templates + creates entities via ORM
- **Limitation:** template engine is shallow — no conditionals, no string transforms, no format control (uppercase, regex patterns, locale-aware fakers)

### Attempt 4: Send functions to the client (discarded)
- Ship JS/Python functions that generate data
- **Killed because:** equivalent to XSS — executing untrusted code on the client's server

---

## Key Insight: Backend-Controlled Generation Is the Right Default

### Why the backend should own data generation

1. **Zero friction**: User installs SDK, we introspect schema via `getSchema()`, we generate the `create` payload. User writes no data code.
2. **Auto-adaptation**: When the schema changes, the fingerprint changes, we detect it and regenerate. The user changes nothing.
3. **Single point of control**: If we improve generation logic (smarter defaults, better faker choices), every user benefits automatically on the next test run.
4. **LLM stays focused**: The LLM generates *specs* (what kind of data), not *values* (the data itself). Much harder to hallucinate `{ model: "User", fields: ["email", "name"] }` than a valid email string.

### Why a pure DSL approach is a tarpit

Building a rich DSL (`$faker`, `$pipe`, `$transform`, `$ref`) sounds good but leads to:

1. **You're building a programming language.** Users will immediately need conditionals, string interpolation, field-to-field derivation. Every "no" makes the DSL feel broken. Every "yes" adds complexity across three language implementations.
2. **Faker API parity is a nightmare.** faker.js has ~250 methods with different names/signatures than Python's Faker. Elixir has no dominant faker lib. Maintaining a cross-language abstraction is massive ongoing work.
3. **The "last 5%" kills you.** The DSL handles `internet.email` beautifully. But real schemas have regex-constrained fields, business-logic validations (valid IBAN, CUIT), derived fields (slug = slugify(title)), and app-layer constraints invisible to schema introspection. For each of these, the user hits the DSL wall.
4. **You're competing with just writing code.** `{ "$faker": "internet.email", "domain": "acme.org" }` is the same as `faker.internet.email({ domain: "acme.org" })` but without autocomplete, type checking, or a debugger.
5. **Three implementations, three bug surfaces.** Every DSL feature needs conformance tests. Every edge case needs identical behavior in TS, Python, and Elixir.

---

## Inspiration: Snaplet Seed

**Link:** https://snaplet-seed.netlify.app/seed/getting-started/overview
*(Project appears abandoned but the design is excellent)*

### What they got right
1. **Schema introspection at CLI time** → generates a fully typed client from the live DB
2. **AI-predicted column semantics** → `email` column gets email-formatted data automatically
3. **Deterministic faker (copycat)** → same seed = same output, no randomness surprises
4. **Relationship abstraction** → nested plans auto-wire FKs, connect pools distribute records
5. **No raw FK IDs ever** → relationships are structural, not data

### What doesn't translate to our context
- They run **client-side TypeScript** — we need cross-language (TS/Python/Elixir)
- They need a **live DB connection at codegen time** — we already have schema via ORM introspection
- Their callbacks ARE functions — which we can't send over the wire

---

## Proposed Architecture: Backend Defaults + Client Escape Hatch

### The three tiers of fields

| Tier | Example | % of fields | Schema tells you enough? |
|------|---------|-------------|--------------------------|
| **Easy** | `name: string`, `age: int`, `email: string` | ~70% | Yes — type + column name → smart default |
| **Medium** | `status: enum('active','pending')`, `country_code: varchar(2)` | ~20% | Yes — enums, constraints, FK targets visible |
| **Hard** | `tax_id` matching `/^\d{2}-\d{7}$/`, `slug` = slugify(title), valid CUIT | ~10% | No — enforced in app layer, invisible to DB |

### Design: backend generates, client patches

```
┌─────────────────────────────────────────────────────┐
│                  Autonoma Backend                    │
│                                                     │
│  Schema (from discover) ──► Smart Default Generator  │
│                              │                      │
│                              ▼                      │
│                    create payload (JSON)             │
│                    (values for all fields)           │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│                  Client SDK                          │
│                                                     │
│  1. Receive create payload                          │
│  2. Run fieldOverrides (user-registered functions)   │
│     - Only for the ~10% of "hard" fields            │
│     - Real code, full flexibility, their process     │
│  3. Resolve templates ({{testRunId}}, etc.)          │
│  4. Create entities via ORM adapter                  │
└─────────────────────────────────────────────────────┘
```

### What the user writes (SDK setup)

**Zero-config (works for 90% of schemas):**
```typescript
// TypeScript
app.post("/api/autonoma", autonomaHandler({
  adapter: prismaAdapter(prisma),
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET,
  signingSecret: process.env.AUTONOMA_INTERNAL_SECRET,
}));
```

**With overrides for hard fields (only when needed):**
```typescript
// TypeScript
app.post("/api/autonoma", autonomaHandler({
  adapter: prismaAdapter(prisma),
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET,
  signingSecret: process.env.AUTONOMA_INTERNAL_SECRET,
  fieldOverrides: {
    "User.tax_id": () => generateArgentineCUIT(),
    "User.slug": (record) => slugify(record.name),
    "Invoice.code": (record, ctx) => `INV-${ctx.testRunId.slice(0, 8)}-${nanoid(4)}`,
  },
}));
```

```python
# Python
@app.post("/api/autonoma")
async def autonoma(request: Request):
    return await autonoma_handler(
        request,
        adapter=sqlalchemy_adapter(session),
        shared_secret=os.environ["AUTONOMA_SHARED_SECRET"],
        signing_secret=os.environ["AUTONOMA_INTERNAL_SECRET"],
        field_overrides={
            "User.tax_id": lambda: generate_argentine_cuit(),
            "User.slug": lambda record: slugify(record["name"]),
        },
    )
```

```elixir
# Elixir
Autonoma.handler(conn,
  adapter: Autonoma.Ecto.Adapter.new(MyApp.Repo),
  shared_secret: System.get_env("AUTONOMA_SHARED_SECRET"),
  signing_secret: System.get_env("AUTONOMA_INTERNAL_SECRET"),
  field_overrides: %{
    "User.tax_id" => fn -> generate_argentine_cuit() end,
    "User.slug" => fn record -> Slug.slugify(record["name"]) end,
  }
)
```

### How field overrides work at runtime

1. Backend sends `create` payload with smart defaults for all fields
2. SDK receives the payload and walks each entity's fields
3. For each field matching a registered override key (`Model.field`):
   - Call the override function, passing the current record data + context
   - Replace the field value with the function's return value
4. Continue with normal flow: template resolution → topo sort → createEntities

Override functions receive:
- `record`: the current field values for this entity (so you can derive slug from name)
- `context`: `{ testRunId, index, ... }` for uniqueness

### Why this works

| Concern | How it's handled |
|---------|------------------|
| Zero friction for most users | Backend generates everything; overrides are optional |
| Schema changes | Backend detects via fingerprint, regenerates payload. Only hard-field overrides need user attention, and only if those specific fields changed. |
| Full flexibility for edge cases | Overrides are real functions — any logic, any library, full IDE support |
| Safety / no XSS | Overrides are registered in the user's own codebase, not sent over the wire |
| Cross-language parity | No faker abstraction needed — each language uses its own tools in overrides |
| Progressive disclosure | Start with zero config. When creation fails, error message suggests adding an override. User adds one line. |
| No DSL to maintain | The only "DSL" is the existing template engine ({{testRunId}}, etc.) which is already built and tested |

### What the backend needs to be good at

For this to work well, the backend's **smart default generator** needs to be solid:

1. **Column name heuristics**: `email` → email format, `phone` → phone format, `url` → URL format, `name` → person name, `created_at` → recent timestamp
2. **Type-aware defaults**: `int` → random int, `boolean` → random bool, `uuid` → uuid v4, `enum` → random valid value
3. **Constraint-aware**: respect `NOT NULL`, `UNIQUE` (append testRunId), `CHECK` constraints when visible in schema
4. **Relationship-aware**: auto-wire FKs based on the dependency graph (already doing this)
5. **Scope-aware**: inject testRunId/scopeValue for isolation (already doing this)

---

## What about the current template engine?

The existing template expressions (`{{testRunId}}`, `{{cycle([...])}}`, `{{random.int()}}`, etc.) remain useful for the backend to embed in payloads. They're resolved client-side, which means:
- `{{testRunId}}` ensures uniqueness without the backend knowing the runtime value
- `{{cycle(...)}}` distributes values across bulk creates
- `{{index}}` provides positional awareness

These are **not** a DSL — they're a thin interpolation layer. They stay as-is.

---

## Open Questions

### Must answer before building

- [ ] **Override execution order**: If `User.slug` depends on `User.name`, and `User.name` also has an override, which runs first? Proposal: run overrides in field-definition order, so users can control sequencing. Or: run all non-dependent overrides first, then dependent ones (requires declaring dependencies — adds complexity).
- [ ] **Override receives generated or original value?**: Should the override function receive the backend-generated value as a parameter (so it can modify rather than replace)? Useful for "take the generated email but force lowercase."
- [ ] **Error UX**: When `createEntities` fails due to a Tier 3 validation, what does the error look like? How do we guide the user to add the right override? Can we detect common patterns (regex constraint violations, etc.) and suggest specific overrides?
- [ ] **Model-level overrides**: Beyond field-level, should we support `"User": (defaults, ctx) => ({ ...defaults, slug: slugify(defaults.name) })`? Simpler API for records where multiple fields are interdependent.
- [ ] **Async overrides**: Some overrides might need async work (e.g., hashing a password, calling an external service). All three languages need to support this.

### Future enhancements

- [ ] **Override scaffolding CLI**: `npx autonoma scaffold-overrides` introspects the schema and generates a starter overrides file with TODO comments for fields that look like they might need custom logic (regex patterns in CHECK constraints, etc.)
- [ ] **Override validation**: Before running tests, call a `validate` step that creates one record per model and reports which fields failed — so users know exactly which overrides they need before the first test run.
- [ ] **Community override packs**: Shared collections of overrides for common patterns (e.g., `@autonoma/overrides-argentina` with CUIT/CUIL generators, `@autonoma/overrides-stripe` with valid-looking Stripe IDs).

---

## Risks

1. **Override maintenance burden**: When hard fields change, users must update overrides. Mitigated by: overrides are only for ~10% of fields, and creation errors surface immediately.
2. **Override ordering complexity**: Field interdependencies could get complex. Start simple (sequential execution), add dependency resolution only if users need it.
3. **Backend default quality**: If the smart defaults are bad (wrong format, unrealistic data), users will need overrides for Tier 1/2 fields too, defeating the purpose. Investment in column-name heuristics is critical.
4. **Breaking change from current approach**: Users currently define their own scenarios in the endpoint. Moving to backend-generated payloads is a fundamentally different model. Needs a migration path.

---

## Recommended Next Steps

1. **Improve the smart default generator** on the backend — column name heuristics, type awareness, constraint detection. This is the foundation.
2. **Add `fieldOverrides` support** to the SDK handler in TypeScript first — validate the API feels right.
3. **Design the error UX** — when creation fails, what message does the user see? How do we guide them to the right override?
4. **Add conformance tests** for override behavior (override called with correct args, override value used, etc.)
5. **Implement in Python and Elixir** once the TS prototype is stable.
6. **Document the migration path** from "user writes scenarios" to "backend generates, user optionally overrides."
