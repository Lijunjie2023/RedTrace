import path from "node:path";
import dotenv from "dotenv";

export interface JustOneApiConfig { token: string; baseUrl: string; timeoutMs: number }

export function parseJustOneApiConfig(env: NodeJS.ProcessEnv): JustOneApiConfig {
  const token = env.JUSTONEAPI_TOKEN;
  if (!token?.trim()) throw new Error("JUSTONEAPI_TOKEN");
  const raw = env.JUSTONEAPI_BASE_URL?.trim() || "https://api.justoneapi.com";
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.hostname !== "api.justoneapi.com" || url.pathname !== "/" || url.search || url.hash || url.username || url.password || url.port) {
    throw new Error("JUSTONEAPI_BASE_URL");
  }
  return { token, baseUrl: url.origin, timeoutMs: 120_000 };
}

export function loadJustOneApiConfig(): JustOneApiConfig {
  dotenv.config({ path: path.resolve(".env.local"), quiet: true });
  return parseJustOneApiConfig(process.env);
}
