# TODO — Discovered During E2E Testing

Issues and features surfaced by running the SDK against the quarita and navigator schemas.

## Bugs Fixed During E2E

- [x] `@updatedAt` fields reported as `hasDefaultValue: false` by DMMF — introspector now treats `isUpdatedAt` and `isGenerated` as defaults
- [x] Scope field injected into models that don't have it (e.g. Organization doesn't have `organizationId`)
- [x] Scope field injection overwrites FK refs templates (e.g. `Application.organizationId` set by `{{refs.Organization[0].id}}` was clobbered)
- [x] Teardown tries to delete models without the scope field (e.g. `WebApplicationData` has no `organizationId`)
- [x] Scope root entity (Organization) not deleted during teardown
- [x] Models without scope field (User, linked through Member join table) not cleaned up — now uses refs ids for targeted deletion

## Lifecycle Hooks Needed

### `auth` hook (partially done)
The SDK calls `config.auth(user)` to get a token. But:
- [ ] Need to support multiple auth strategies (the user entity might not be named "User")
- [ ] Need to support "authenticate as user N" not just user 0
- [ ] Need a hook to create auth sessions/tokens via the customer's auth system (BetterAuth, WorkOS, etc.) rather than just returning a fake JWT

### `beforeCreate` / `afterCreate` hooks
- [ ] **Json fields with typed structures** — quarita has `conversation Json @default("[]")`, navigator has `metadata Json`, `applicationMetadata Json`, `appConfiguration Json`. The LLM can't know the valid shapes. Need a hook: `beforeCreate(model, fields)` that lets the customer fill in complex Json fields, or a schema extension that documents the Json shapes.
- [ ] **Computed/derived fields** — some fields may need to be computed from other fields (e.g. a `slug` derived from `name`). A `beforeCreate` hook would let customers add this logic.

### `onFileNeeded` hook
- [ ] Many E2E tests need files (screenshots, uploads, APKs, test artifacts). Navigator has `screenshotBefore`, `screenshotAfter`, `physicalDevicePath`, `packageUrl`. Quarita has `screenshotBefore`, `screenshotAfter` on steps.
- [ ] Need a hook: `onFileNeeded(field, context) → url` that lets customers generate/upload files to S3 (or return a fixture URL) during entity creation.
- [ ] Alternatively, support a `{{file(...)}}` template expression that references pre-uploaded fixture files.

### `afterUp` / `beforeDown` hooks
- [ ] After creating all entities, the customer might need to trigger side effects (warm caches, seed search indexes, start background jobs).
- [ ] Before teardown, they might need to stop running processes, revoke tokens, etc.

## Scope Field Design

The current design assumes `scopeField` is a FK that child models have pointing to a root entity. This works for org-scoped apps (quarita, navigator) but:
- [ ] **Models without the scope field** are only cleaned up if their ids are in `refs`. Records created by the app DURING the test (not by the SDK) and lacking the scope field won't be cleaned up. Consider: require all test-relevant models to have the scope field, OR track all created record ids during the test.
- [ ] **Multiple scope roots** — what if a test needs two organizations? Currently the scope value is a single string. May need to support scope as a mapping.
- [ ] **Non-FK scope fields** — the original design assumed `scopeField` could be a dedicated `testRunId` column added to every model. This is simpler (every model gets it, teardown is straightforward) but requires schema changes. Document both approaches.

## Validator Improvements

- [ ] **Detect `@updatedAt` fields at the schema level** — the autonoma-schema.json should mark fields as auto-managed so the validator doesn't require them. Currently fixed in the Prisma introspector but the schema JSON format doesn't expose `isUpdatedAt`.
- [ ] **Enum validation** — the DMMF has enum values. The validator should check that enum fields use valid values from the Prisma schema.
- [ ] **Json field shape hints** — allow the schema to declare expected Json shapes so the validator can check them.
- [ ] **Unique constraint awareness** — warn when a field with a unique constraint doesn't have unique values across instances.

## Skill / Documentation

- [ ] Rewrite the skill doc to be simpler and more concrete — the E2E walkthrough is a better teaching tool than the current reference-style document
- [ ] Add the "here's how to think about what data to create" section based on FK edge traversal
- [ ] Document the scope field design tradeoffs (org-scoped vs testRunId-scoped)
- [ ] Add examples from both quarita and navigator as reference scenarios
