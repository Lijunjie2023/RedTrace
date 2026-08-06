import { createHash } from "node:crypto";

const SECRET_KEYS = new Set([
  "a1",
  "xs",
  "xt",
  "cookie",
  "token",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "xsectoken",
  "authorization",
  "websession",
  "sessionkey",
  "clientsecret",
  "apikey",
  "password",
  "passwd",
  "secret",
  "session",
  "phone",
  "mobile",
  "captcha",
  "verify"
]);
const PHONE = /(?<![A-Za-z0-9])(?:\+?86[- ]?)?1[3-9]\d{9}(?![A-Za-z0-9])/g;
const SECRET_QUERY = /([?&](?:a1|x-s|x-t|xsec[_-]?token|token|auth[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|web[_-]?session|session(?:[_-]?key)?|client[_-]?secret|api[_-]?key|cookie)=)[^&#\s]*/gi;
const SECRET_HEADER = /(\b(?:cookie|authorization|x-s|x-t)\s*:\s*)[^\r\n]*/gi;

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.replace(/[_-]/g, "").toLowerCase());
}

export function sanitizeText(value: string): string {
  return value
    .replace(PHONE, "[redacted-phone]")
    .replace(SECRET_QUERY, "$1[redacted]")
    .replace(SECRET_HEADER, "$1[redacted]");
}

export function sanitizeUnknown(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return sanitizeText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeUnknown(item, seen));

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSecretKey(key)) continue;
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
