const SECRET_KEYS = new Set([
  "token", "access_token", "api_key", "apikey", "password", "passwd", "secret",
  "cookie", "set-cookie", "authorization", "x-s", "x-t", "a1", "xsec_token", "xsec_source"
]);

function cleanUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) if (SECRET_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
    return url.toString();
  } catch { return raw; }
}

export function sanitizeApiValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeApiValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SECRET_KEYS.has(key.toLowerCase()))
      .map(([key, nested]) => [key, sanitizeApiValue(nested)]));
  }
  if (typeof value === "string" && /^https?:\/\//i.test(value)) return cleanUrl(value);
  return value;
}
