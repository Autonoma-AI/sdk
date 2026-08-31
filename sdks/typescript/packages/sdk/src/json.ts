/**
 * Small helpers for reading values out of an untrusted, already-parsed JSON
 * body without `as` casts. Shared by the handler and the check runner so the
 * readers live in exactly one place.
 */

/** Read a string property, or `undefined` if it is absent or not a string. */
export function readString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

/** Read an `error` message from a response body, defaulting to a generic one. */
export function readError(body: Record<string, unknown>): string {
  return readString(body, "error") ?? "Unknown error";
}

/** Narrow an untrusted value to a plain object (record) without a cast. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
