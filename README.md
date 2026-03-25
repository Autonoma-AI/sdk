# Autonoma SDK

Isolated test data for every E2E test run. Install the SDK, point it at your database, and get a working Environment Factory endpoint in ~15 lines.

```typescript
// app/api/autonoma/route.ts
import { createHandler } from '@autonoma/server-web'
import { prismaAdapter } from '@autonoma/sdk-prisma'
import { prisma } from '@/lib/db'

export const POST = createHandler({
  adapter: prismaAdapter(prisma, { scopeField: 'organizationId' }),
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
  auth: async (user) => {
    const session = await createSession(user.id as string)
    return { token: session.token }
  },
})
```

The SDK reads your schema, creates records in FK order, resolves templates for unique values, and tears down everything after the test — scoped by organization, verified by cryptographic signature.

## How it works

```
Autonoma Platform                        Your Backend
      │                                       │
      │──── POST { action: "discover" } ─────▶│  SDK reads your ORM schema
      │◀─── { models, fields, edges } ────────│  and returns it
      │                                       │
      │──── POST { action: "up", create: {    │  SDK creates records in FK order,
      │       Organization: [{ ... }]         │  resolves templates ({{testRunId}}),
      │     }} ──────────────────────────────▶│  returns auth credentials + signed token
      │◀─── { auth, refs, refsToken } ────────│
      │                                       │
      │        ... tests run ...              │
      │                                       │
      │──── POST { action: "down",            │  SDK verifies the token signature,
      │       refsToken: "..." } ────────────▶│  deletes only the records it created
      │◀─── { ok: true } ─────────────────────│
```

## Packages

Install the core + one ORM adapter + one server adapter:

```bash
pnpm add @autonoma/sdk @autonoma/sdk-prisma @autonoma/server-web
```

| Package | What it does |
|---------|-------------|
| `@autonoma/sdk` | Core protocol — HMAC verification, JWT refs, template engine, FK graph |
| `@autonoma/sdk-prisma` | Prisma adapter — schema introspection, entity creation, scoped teardown |
| `@autonoma/sdk-drizzle` | Drizzle adapter — same contract, different ORM |
| `@autonoma/server-web` | Web standard adapter — Next.js App Router, Hono, Bun, Deno |
| `@autonoma/server-express` | Express adapter |
| `@autonoma/server-node` | Node.js http adapter |

## Scenario data

Tests describe what data they need as a nested JSON tree. The SDK handles FK wiring, template resolution, and creation order.

```json
{
  "create": {
    "Organization": [{
      "name": "Acme [{{testRunId}}]",
      "slug": "acme-{{testRunId}}",
      "members": [
        { "role": "owner", "user": [{ "name": "Alice", "email": "alice-{{testRunId}}@test.com" }] },
        { "role": "admin", "user": [{ "name": "Bob", "email": "bob-{{testRunId}}@test.com" }] }
      ],
      "applications": [{
        "_alias": "webApp",
        "name": "Marketing Website",
        "architecture": "WEB",
        "tags": [{ "name": "Critical", "color": "#DC2626" }],
        "testPlans": [{
          "name": "Smoke Plan",
          "plan": "content",
          "testGenerations": [{
            "_alias": "gen1",
            "conversation": "[]",
            "applicationId": { "_ref": "webApp" }
          }]
        }],
        "tests": [{
          "name": "Homepage Test",
          "testGenerationId": { "_ref": "gen1" },
          "runs": [{ "_count": 10000, "_batch": true }]
        }]
      }]
    }]
  }
}
```

Features:
- **Nesting** — FK relationships are inferred from your schema. Nest children under parents, the SDK sets the foreign keys.
- **`_alias` / `_ref`** — Reference records across branches of the tree.
- **`_count` / `_batch`** — Bulk insert thousands of records in a single SQL statement.
- **Templates** — `{{testRunId}}`, `{{index}}`, `{{cycle([...])}}`, `{{random.int(a,b)}}`, `{{now()}}`, `{{daysAgo(n)}}`.

## Validation

Validate scenarios against a real database before deploying:

```typescript
import { checkScenario } from '@autonoma/sdk'

const result = await checkScenario(adapter, scenario)
// result.valid    → true/false
// result.phase    → 'ok' | 'up' | 'down'
// result.errors   → [{ message, fix }]
// result.timing   → { upMs, downMs }
```

`checkScenario` runs the full create-then-teardown cycle. If it fails, `result.errors[0].fix` tells you exactly what to change.

## Safety

- **Blocked in production** — Returns 404 when `NODE_ENV=production` (unless explicitly opted in)
- **Up can only create** — Calls ORM `.create()` and `.createMany()` only. No UPDATE, DELETE, DROP, or raw SQL.
- **Down can only delete what up created** — Verified by a JWT signed with your private key. Even Autonoma can't forge it.
- **Requests are authenticated** — HMAC-SHA256 on every request. Unsigned = 401.
- **Two separate secrets** — Shared secret (HMAC, known by both sides) and signing secret (JWT, only you know it). SDK throws if they're the same.

## Documentation

Full documentation: [`docs/web-docs/llms/`](docs/web-docs/llms/)

| Page | What it covers |
|------|---------------|
| [Overview](docs/web-docs/llms/overview.txt) | What the Environment Factory is, scope field, secrets |
| [Setup Guide](docs/web-docs/llms/setup.txt) | Install, configure, auth callback, verify, deploy |
| [Scenarios](docs/web-docs/llms/scenarios.txt) | Nested format, nesting, templates, aliases, batch, examples |
| [Validation](docs/web-docs/llms/validation.txt) | checkScenario, error types, testcontainers, fix loop |
| [Adapters](docs/web-docs/llms/adapters.txt) | ORM/Server/Auth adapter interfaces for building new adapters |
| [Agent Prompt](docs/web-docs/llms/agent-prompt.txt) | Complete prompt for an AI agent to set up the SDK in a codebase |
| [All pages](docs/web-docs/llms/llms-full.txt) | Everything in one file |

## Development

```bash
pnpm install          # install deps
pnpm build            # build all packages
pnpm test             # build + test
npx vitest run        # run tests directly (faster)
```

## License

Private — Autonoma AI
