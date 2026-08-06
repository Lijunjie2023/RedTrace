import type { JustOneApiConfig } from "./config.js";

export interface ApiEnvelope { code?: number; message?: unknown; data?: unknown; recordTime?: unknown; requestId?: unknown }

export class JustOneApiClient {
  constructor(private readonly config: JustOneApiConfig) {}

  async get(pathname: string, params: Record<string, string | number>): Promise<ApiEnvelope> {
    const url = new URL(pathname, this.config.baseUrl);
    url.searchParams.set("token", this.config.token);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const response = await fetch(url, { signal: AbortSignal.timeout(this.config.timeoutMs) });
    const body = await response.json() as ApiEnvelope;
    if (!response.ok || body.code !== 0) throw new Error(`api_failed:${pathname}:http_${response.status}:code_${String(body.code)}`);
    return body;
  }
}
