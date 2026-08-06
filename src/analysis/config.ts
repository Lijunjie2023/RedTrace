import path from "node:path";
import dotenv from "dotenv";

export interface DeepSeekConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  batchLimit: number;
  batchTokenBudget: number;
  maxOutputTokens: number;
  maxResponseBytes: number;
  claimLeaseMs: number;
  promptVersion: string;
}

export class AnalysisConfigError extends Error {
  constructor(readonly field: string) {
    super(`分析服务配置无效：${field}`);
    this.name = "AnalysisConfigError";
  }
}

function integer(env: NodeJS.ProcessEnv, field: string, fallback: number, minimum: number, maximum: number): number {
  const raw = env[field]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new AnalysisConfigError(field);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new AnalysisConfigError(field);
  return value;
}

export function parseDeepSeekConfig(env: NodeJS.ProcessEnv): DeepSeekConfig {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey?.trim()) throw new AnalysisConfigError("DEEPSEEK_API_KEY");
  const rawBaseUrl = env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com";
  let baseUrl: string;
  try {
    const url = new URL(rawBaseUrl);
    const pathName = url.pathname.replace(/\/$/, "") || "/";
    if (url.protocol !== "https:" || url.hostname !== "api.deepseek.com"
      || (pathName !== "/" && pathName !== "/v1")
      || url.port || url.username || url.password || url.search || url.hash) {
      throw new Error("invalid");
    }
    baseUrl = `${url.origin}${pathName === "/" ? "" : pathName}`;
  } catch {
    throw new AnalysisConfigError("DEEPSEEK_BASE_URL");
  }
  const timeoutMs = integer(env, "DEEPSEEK_TIMEOUT_MS", 30_000, 1_000, 120_000);
  const maxRetries = integer(env, "DEEPSEEK_MAX_RETRIES", 2, 0, 5);
  const batchTokenBudget = integer(env, "DEEPSEEK_BATCH_TOKEN_BUDGET", 20_000, 100, 1_000_000);
  const maxOutputTokens = integer(env, "DEEPSEEK_MAX_OUTPUT_TOKENS", 800, 100, 4_096);
  const maxResponseBytes = integer(env, "DEEPSEEK_MAX_RESPONSE_BYTES", 1_048_576, 1_024, 10_485_760);
  const claimLeaseMs = integer(env, "DEEPSEEK_CLAIM_LEASE_MS", 180_000, 10_000, 900_000);
  const retryWaitMs = Array.from({ length: maxRetries }, (_, index) => 500 * 2 ** index)
    .reduce((total, value) => total + value, 0);
  if (claimLeaseMs < timeoutMs * (maxRetries + 1) + retryWaitMs + 5_000) {
    throw new AnalysisConfigError("DEEPSEEK_CLAIM_LEASE_MS");
  }
  if (batchTokenBudget < maxOutputTokens) throw new AnalysisConfigError("DEEPSEEK_BATCH_TOKEN_BUDGET");
  return {
    apiKey,
    baseUrl,
    model: env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash",
    timeoutMs,
    maxRetries,
    batchLimit: integer(env, "DEEPSEEK_BATCH_LIMIT", 10, 1, 100),
    batchTokenBudget,
    maxOutputTokens,
    maxResponseBytes,
    claimLeaseMs,
    promptVersion: env.DEEPSEEK_PROMPT_VERSION?.trim() || "content-analysis-v1"
  };
}

export function loadDeepSeekConfig(): DeepSeekConfig {
  dotenv.config({ path: path.resolve(".env.local"), quiet: true });
  return parseDeepSeekConfig(process.env);
}
