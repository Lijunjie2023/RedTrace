import { createHash } from "node:crypto";

const SECRET_KEY = /cookie|token|authorization|password|passwd|secret|session|phone|mobile|captcha|verify/i;
const PHONE = /(?<![A-Za-z0-9])(?:\+?86[- ]?)?1[3-9]\d{9}(?![A-Za-z0-9])/g;
const SECRET_QUERY = /([?&](?:xsec_token|token|access_token|session|cookie)=)[^&#\s]+/gi;

export function sanitizeText(value: string): string {
  return value
    .replace(PHONE, "[redacted-phone]")
    .replace(SECRET_QUERY, "$1[redacted]");
}

export function sanitizeUnknown(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return sanitizeText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeUnknown(item, seen));

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    result[key] = sanitizeUnknown(item, seen);
  }
  return result;
}

export function safeErrorSummary(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeText(raw)
    .replace(/https?:\/\/[^\s]+/g, "[redacted-url]")
    .slice(0, 500);
}

export function hashRunInput(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
