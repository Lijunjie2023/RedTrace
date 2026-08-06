import { sanitizeUnknown } from "../../xhs-probe/sanitize.js";
import { PersistenceError } from "./errors.js";

export const RAW_REDACTION_VERSION = "xhs-probe-v1";

function assertSafeJsonValue(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value !== "object") throw new Error("unsupported_json_value");
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertSafeJsonValue(item, seen);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === "toJSON") throw new Error("custom_json_serializer_not_allowed");
    assertSafeJsonValue(item, seen);
  }
}

export function serializeSanitizedPayload(payload: unknown): string {
  try {
    const sanitized = sanitizeUnknown(payload);
    assertSafeJsonValue(sanitized);
    const serialized = JSON.stringify(sanitized);
    if (serialized === undefined) throw new Error("not_serializable");
    return serialized;
  } catch {
    throw new PersistenceError(
      "raw_snapshot_sanitize_failed",
      "raw_snapshot_sanitize_failed"
    );
  }
}
