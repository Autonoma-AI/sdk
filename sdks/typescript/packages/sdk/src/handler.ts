/**
 * Request routing for discover / up / down protocol actions (Scenario v2).
 *
 * `discover` lists the registered scenarios; `up` looks a scenario up by
 * name, runs its free-form `up`, signs a teardown token carrying the scenario
 * name, and responds; `down` recovers the scenario name from the verified
 * token and routes to that scenario's `down`. There is no create-graph
 * interpreter and no factory-derived discover schema.
 */
import type {
  DiscoverResponse,
  DownResponse,
  HandlerConfig,
  HandlerRequest,
  HandlerResponse,
  ScenarioDefinition,
  ScenarioTeardown,
  SdkInfo,
  UpResponse,
} from "./types";
import { verifySignature } from "./hmac";
import { readString, isRecord } from "./json";
import { signRefs, verifyRefs, type RefsPayload } from "./refs";
import { AutonomaError, Errors } from "./errors";

const DEFAULT_EXPIRES_IN_SECONDS = 3600;

declare const __PROTOCOL_VERSION__: string;
export const PROTOCOL_VERSION =
  typeof __PROTOCOL_VERSION__ === "string" ? __PROTOCOL_VERSION__ : "2.0";

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

// One-shot runtime signal for plain-JS users who never see the @deprecated
// JSDoc on the config type.
let warnedDeprecatedAllowProduction = false;

export async function handleRequest(
  config: HandlerConfig,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  try {
    if (config.allowProduction !== undefined && !warnedDeprecatedAllowProduction) {
      warnedDeprecatedAllowProduction = true;
      console.warn(
        "[autonoma] allowProduction is deprecated and ignored - the endpoint is always enabled",
      );
    }

    if (config.sharedSecret === config.signingSecret) {
      throw new AutonomaError(
        "sharedSecret and signingSecret must be different. The shared secret is known by Autonoma; the signing secret must be private.",
        "SAME_SECRETS",
        500,
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

    const action = readString(body, "action");
    if (action == null)
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
  const scenarios = (config.scenarios ?? []).map((s) => ({
    name: s.name,
    description: s.description,
  }));
  const body: DiscoverResponse = { ...buildSdkMeta(config), scenarios };
  return { status: 200, body };
}

async function handleUp(
  config: HandlerConfig,
  body: Record<string, unknown>,
): Promise<HandlerResponse> {
  const name = readScenarioName(body);
  if (name == null)
    throw Errors.invalidBody('missing "scenario.name" in request body');

  const scenario = findScenario(config, name);
  if (!scenario) throw Errors.unknownEnvironment(name);

  const testRunId = readString(body, "testRunId") ?? randomUUID();

  const result = (await scenario.up({ testRunId })) ?? {};

  const teardown: ScenarioTeardown = result.teardown ?? {};
  const teardownToken = signRefs(
    { refs: teardown, testRunId, environment: name },
    config.signingSecret,
  );

  const expiresInSeconds = config.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS;

  const responseBody: UpResponse = {
    ...buildSdkMeta(config),
    teardownToken,
    expiresInSeconds,
  };
  if (result.auth !== undefined) responseBody.auth = result.auth;

  return { status: 200, body: responseBody };
}

async function handleDown(
  config: HandlerConfig,
  body: Record<string, unknown>,
): Promise<HandlerResponse> {
  const teardownToken = readString(body, "teardownToken");
  if (teardownToken == null || teardownToken.length === 0)
    throw Errors.invalidBody("missing teardownToken");

  let payload: RefsPayload;
  try {
    payload = verifyRefs(teardownToken, config.signingSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid token";
    throw Errors.invalidTeardownToken(message);
  }

  const teardown: ScenarioTeardown = payload.refs ?? {};
  const testRunId = payload.testRunId ?? "";
  // The verified token is authoritative for routing; any scenario name on
  // the request body is ignored.
  const name = payload.environment ?? "";

  const scenario = name ? findScenario(config, name) : undefined;
  if (scenario?.down) {
    await scenario.down({ name, teardown, testRunId });
  }

  const responseBody: DownResponse = { ...buildSdkMeta(config), ok: true };
  return { status: 200, body: responseBody };
}

function findScenario(
  config: HandlerConfig,
  name: string,
): ScenarioDefinition | undefined {
  return (config.scenarios ?? []).find((s) => s.name === name);
}

/** Read `body.scenario.name` from an untrusted JSON body without casts. */
function readScenarioName(body: Record<string, unknown>): string | undefined {
  const scenario = body.scenario;
  return isRecord(scenario) ? readString(scenario, "name") : undefined;
}

function randomUUID(): string {
  // Node 18+ has globalThis.crypto.randomUUID; the SDK targets >=18.
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  // Fallback that should never trigger in supported runtimes.
  return `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
