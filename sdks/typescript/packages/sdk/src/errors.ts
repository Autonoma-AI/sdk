export class AutonomaError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "AutonomaError";
  }
}

export const Errors = {
  unknownAction(action: string) {
    return new AutonomaError(
      `Unknown action: ${action}`,
      "UNKNOWN_ACTION",
      400,
    );
  },
  unknownEnvironment(name: string) {
    return new AutonomaError(
      `Unknown environment: ${name}`,
      "UNKNOWN_ENVIRONMENT",
      400,
    );
  },
  invalidSignature() {
    return new AutonomaError(
      "Invalid HMAC signature",
      "INVALID_SIGNATURE",
      401,
    );
  },
  invalidRefsToken(reason: string) {
    return new AutonomaError(
      `Invalid refs token: ${reason}`,
      "INVALID_REFS_TOKEN",
      403,
    );
  },
  productionBlocked(detail?: string) {
    return new AutonomaError(
      `Environment factory is disabled in production${detail != null ? `. ${detail}` : ""}`,
      "PRODUCTION_BLOCKED",
      404,
    );
  },
  invalidBody(reason: string) {
    return new AutonomaError(
      `Invalid request body: ${reason}`,
      "INVALID_BODY",
      400,
    );
  },
} as const;
