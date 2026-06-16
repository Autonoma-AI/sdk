/**
 * Request routing for discover / up / down protocol actions.
 *
 * Factory-driven design: every model in `body.create` must have a
 * registered factory. The SDK uses each factory's `inputSchema` (Zod)
 * to validate inputs and to build the `discover` schema. Ordering for
 * `up` and `down` comes from the create payload's `_alias` / `_ref`
 * graph (see `payload-topo.ts`); there is no SQL introspection.
 */
import type {
  AuthResult,
  FactoryContext,
  HandlerConfig,
  HandlerRequest,
  HandlerResponse,
  HookContext,
  SdkInfo,
} from "./types";
import { verifySignature } from "./hmac";
import { signRefs, verifyRefs, type RefsPayload } from "./refs";
import { AutonomaError, Errors } from "./errors";
import { resolvePayloadTree, computeTeardownOrder } from "./payload-topo";
import { buildSchemaFromFactories, schemaToWire } from "./schema";

const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const CYCLE_RE = /^cycle\((.*)\)$/;

/**
 * Substitute built-in tokens in field values: {{testRunId}}, {{index}},
 * {{cycle(a,b,c)}}. Defense-in-depth: the test runner should substitute
 * recipe variables before calling /up, but if a literal {{…}} slips
 * through we fail loudly with UNRESOLVED_TOKEN rather than INSERT the
 * raw string.
 */
export function resolveTokens(
  value: unknown,
  testRunId: string,
  index: number,
): unknown {
  if (typeof value === "string") {
    return value.replace(TOKEN_RE, (_match, rawToken: string) => {
      const token = rawToken.trim();
      if (token === "testRunId") return testRunId;
      if (token === "index") return String(index);
      const cycle = CYCLE_RE.exec(token);
      if (cycle) {
        const parts = cycle[1]!
          .split(",")
          .map((p) => p.trim().replace(/^['"]|['"]$/g, ""));
        return parts.length ? parts[index % parts.length]! : "";
      }
      throw new AutonomaError(
        `Unresolved token: {{${token}}}`,
        "UNRESOLVED_TOKEN",
        400,
      );
    });
  }
  if (Array.isArray(value))
    return value.map((v) => resolveTokens(v, testRunId, index));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveTokens(v, testRunId, index);
    }
    return out;
  }
  return value;
}

declare const __PROTOCOL_VERSION__: string;
export const PROTOCOL_VERSION =
  typeof __PROTOCOL_VERSION__ === "string" ? __PROTOCOL_VERSION__ : "1.0";

function buildSdkMeta(config: HandlerConfig): {
  version: string;
  sdk: SdkInfo;
} {
  return {
    version: PROTOCOL_VERSION,
    sdk: {
      language: "typescript",
      orm: config.sdk?.orm ?? "unknown",
      server: config.sdk?.server ?? "unknown",
    },
  };
}

export async function handleRequest(
  config: HandlerConfig,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  try {
    if (config.sharedSecret === config.signingSecret) {
      throw new AutonomaError(
        "sharedSecret and signingSecret must be different. The shared secret is known by Autonoma; the signing secret must be private.",
        "SAME_SECRETS",
        500,
      );
    }

    if (!config.allowProduction) {
      throw Errors.productionBlocked(
        "Set allowProduction: true to enable the endpoint.",
      );
    }

    const signature =
      req.headers["x-signature"] ?? req.headers["X-Signature"] ?? "";
    if (!verifySignature(req.body, signature, config.sharedSecret)) {
      throw Errors.invalidSignature();
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(req.body);
    } catch {
      throw Errors.invalidBody("invalid JSON");
    }

    const action = body.action as string;
    if (!action)
      throw Errors.invalidBody(
        'missing action. expected one of "discover", "up" or "down"',
      );

    switch (action) {
      case "discover":
        return await handleDiscover(config);
      case "up":
        return await handleUp(config, body);
      case "down":
        return await handleDown(config, body);
      default:
        throw Errors.unknownAction(action);
    }
  } catch (err) {
    if (err instanceof AutonomaError) {
      return {
        status: err.status,
        body: { error: err.message, code: err.code },
      };
    }
    const message = err instanceof Error ? err.message : "Internal error";
    return { status: 500, body: { error: message, code: "INTERNAL_ERROR" } };
  }
}

async function handleDiscover(config: HandlerConfig): Promise<HandlerResponse> {
  const schema = buildSchemaFromFactories(
    config.factories ?? {},
    config.scopeField,
  );
  return {
    status: 200,
    body: { ...buildSdkMeta(config), schema: schemaToWire(schema) },
  };
}

async function handleUp(
  config: HandlerConfig,
  body: Record<string, unknown>,
): Promise<HandlerResponse> {
  const create = body.create as Record<string, unknown> | undefined;
  if (!create) throw Errors.invalidBody('missing "create" in request body');

  const testRunId = (body.testRunId as string) ?? randomUUID();

  const factories = config.factories ?? {};
  if (Object.keys(factories).length === 0) {
    throw Errors.invalidBody(
      "no factories registered — every model in `create` must have a factory.",
    );
  }

  const tree = resolvePayloadTree(create);

  const refs: Record<string, Record<string, unknown>[]> = {};
  const idMap = new Map<string, string | number>();

  // Track per-model run index for {{index}} / {{cycle()}} substitution.
  const modelIndex: Record<string, number> = {};

  for (const op of tree.ops) {
    const model = op.model;
    const factory = factories[model];
    if (!factory) {
      throw Errors.invalidBody(
        `no factory registered for model "${model}". ` +
          "Register one with `defineFactory(...)` and add it to HandlerConfig.factories.",
      );
    }

    const idx = modelIndex[model] ?? 0;
    modelIndex[model] = idx + 1;

    // Substitute built-in tokens then swap temp ids for real ids.
    const tokenResolved = resolveTokens(op.fields, testRunId, idx) as Record<
      string,
      unknown
    >;
    const swapped = swapTempIds(tokenResolved, idMap) as Record<
      string,
      unknown
    >;

    // Validate through the factory's input schema and call create.
    const parsed = factory.inputSchema.safeParse(swapped);
    if (!parsed.success) {
      const formatted = parsed.error.issues
        .map(
          (i: { path: (string | number)[]; message: string }) =>
            `${i.path.join(".") || "<root>"}: ${i.message}`,
        )
        .join("; ");
      throw new AutonomaError(
        `Invalid input for "${model}": ${formatted}`,
        "INTERNAL_ERROR",
        500,
      );
    }
    const ctx: FactoryContext = { refs, scenarioName: testRunId, testRunId };
    const recordRaw = await factory.create(parsed.data, ctx);

    const record = normaliseRecord(recordRaw);
    if (!record || record.id == null) {
      throw new AutonomaError(
        `Factory for "${model}" must return a record with "id"`,
        "FACTORY_MISSING_PK",
        500,
      );
    }

    (refs[model] ??= []).push(record);
    idMap.set(op.tempId, record.id as string | number);
  }

  const authUser = findFirstUser(refs);
  const scopeValue = detectScopeValue(refs, config.scopeField) ?? testRunId;
  let auth: AuthResult = await config.auth(authUser, { scopeValue, refs });

  if (config.afterUp) {
    const hookCtx: HookContext = { scenarioName: scopeValue, refs };
    auth = await config.afterUp(hookCtx, auth);
  }

  const refsToken = signRefs(
    {
      refs,
      testRunId: scopeValue,
      environment: "",
      aliasDependencies: tree.aliasDependencies,
      aliasOwnerModel: tree.aliasOwnerModel,
    },
    config.signingSecret,
  );

  return {
    status: 200,
    body: { ...buildSdkMeta(config), auth, refs, refsToken },
  };
}

async function handleDown(
  config: HandlerConfig,
  body: Record<string, unknown>,
): Promise<HandlerResponse> {
  const refsToken = body.refsToken as string;
  if (!refsToken) throw Errors.invalidBody("missing refsToken");

  let payload: RefsPayload;
  try {
    payload = verifyRefs(refsToken, config.signingSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid token";
    throw Errors.invalidRefsToken(message);
  }

  const refs = payload.refs ?? {};
  const testRunId = payload.testRunId ?? "";

  if (config.beforeDown) {
    const hookCtx: HookContext = { scenarioName: testRunId, refs };
    await config.beforeDown(hookCtx);
  }

  const factories = config.factories ?? {};
  const teardownOrder = computeTeardownOrder(
    refs,
    payload.aliasDependencies,
    payload.aliasOwnerModel,
  );

  for (const model of teardownOrder) {
    const factory = factories[model];
    if (!factory || !factory.teardown) continue;
    const records = refs[model] ?? [];
    const ctx: FactoryContext = { refs, scenarioName: testRunId, testRunId };
    for (const record of [...records].reverse()) {
      let teardownInput: unknown = record;
      if (factory.refSchema) {
        const parsed = factory.refSchema.safeParse(record);
        if (!parsed.success) {
          const formatted = parsed.error.issues
            .map(
              (i: { path: (string | number)[]; message: string }) =>
                `${i.path.join(".") || "<root>"}: ${i.message}`,
            )
            .join("; ");
          throw new AutonomaError(
            `Invalid teardown record for "${model}": ${formatted}`,
            "INTERNAL_ERROR",
            500,
          );
        }
        teardownInput = parsed.data;
      }
      await factory.teardown(teardownInput as never, ctx);
    }
  }

  return { status: 200, body: { ...buildSdkMeta(config), ok: true } };
}

function swapTempIds(
  value: unknown,
  idMap: Map<string, string | number>,
): unknown {
  if (typeof value === "string" && value.startsWith("__temp_")) {
    return idMap.get(value) ?? value;
  }
  if (Array.isArray(value)) return value.map((v) => swapTempIds(v, idMap));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = swapTempIds(v, idMap);
    }
    return out;
  }
  return value;
}

function normaliseRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function findFirstUser(
  refs: Record<string, Record<string, unknown>[]>,
): Record<string, unknown> | null {
  for (const [model, records] of Object.entries(refs)) {
    const normalized = model.toLowerCase();
    if (
      (normalized === "user" || normalized === "users") &&
      records.length > 0
    ) {
      return records[0]!;
    }
  }
  return null;
}

function detectScopeValue(
  refs: Record<string, Record<string, unknown>[]>,
  scopeField: string,
): string | null {
  const scopeNormalized = scopeField.replace(/_/g, "").toLowerCase();
  for (const records of Object.values(refs)) {
    for (const record of records) {
      for (const [key, value] of Object.entries(record)) {
        if (
          key.replace(/_/g, "").toLowerCase() === scopeNormalized &&
          typeof value === "string"
        ) {
          return value;
        }
      }
    }
  }
  return null;
}

function randomUUID(): string {
  // Node 18+ has globalThis.crypto.randomUUID; the SDK targets >=18.
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  // Fallback that should never trigger in supported runtimes.
  return `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
