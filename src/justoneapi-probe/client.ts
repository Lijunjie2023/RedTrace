import type { JustOneApiConfig } from "./config.js";

export interface ApiEnvelope { code?: number; message?: unknown; data?: unknown; recordTime?: unknown; requestId?: unknown }

export type JustOneApiErrorCode =
  | "authentication_failed"
  | "rate_limited"
  | "service_unavailable"
  | "request_rejected"
  | "response_invalid"
  | "network_error";

export class JustOneApiRequestError extends Error {
  constructor(readonly code: JustOneApiErrorCode, readonly retryable: boolean) {
    super(code);
    this.name = "JustOneApiRequestError";
  }
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type Sleep = (durationMs: number) => Promise<void>;

export class JustOneApiClient {
  constructor(
    private readonly config: JustOneApiConfig,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
    private readonly sleep: Sleep = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
    private readonly maxRetries = 2
  ) {}

  async get(pathname: string, params: Record<string, string | number>): Promise<ApiEnvelope> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.request(pathname, params);
      } catch (error) {
        if (!(error instanceof JustOneApiRequestError) || !error.retryable || attempt === this.maxRetries) throw error;
        await this.sleep(500 * 2 ** attempt);
      }
    }
    throw new JustOneApiRequestError("service_unavailable", false);
  }

  private async request(pathname: string, params: Record<string, string | number>): Promise<ApiEnvelope> {
    const url = new URL(pathname, this.config.baseUrl);
    url.searchParams.set("token", this.config.token);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    try {
      const response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(this.config.timeoutMs),
        redirect: "error"
      });
      if (response.status === 401 || response.status === 403) {
        throw new JustOneApiRequestError("authentication_failed", false);
      }
      if (response.status === 429) throw new JustOneApiRequestError("rate_limited", true);
      if (response.status >= 500) throw new JustOneApiRequestError("service_unavailable", true);
      if (!response.ok) throw new JustOneApiRequestError("request_rejected", false);
      let body: ApiEnvelope;
      try {
        body = await response.json() as ApiEnvelope;
      } catch {
        throw new JustOneApiRequestError("response_invalid", false);
      }
      if (body.code !== 0) throw new JustOneApiRequestError("request_rejected", false);
      return body;
    } catch (error) {
      if (error instanceof JustOneApiRequestError) throw error;
      throw new JustOneApiRequestError("network_error", true);
    }
  }
}
