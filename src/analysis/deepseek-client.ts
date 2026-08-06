import { z } from "zod";
import type { DeepSeekConfig } from "./config.js";
import { AnalysisValidationError } from "./schema.js";
import type { AnalysisClient, TokenUsage } from "./types.js";

const ResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().min(1) }).passthrough() }).passthrough()).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().min(0).optional(),
    completion_tokens: z.number().int().min(0).optional(),
    total_tokens: z.number().int().min(0).optional()
  }).optional()
}).passthrough();

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type Sleep = (durationMs: number) => Promise<void>;

export class DeepSeekRequestError extends Error {
  constructor(
    readonly errorCode: string,
    readonly retryable: boolean,
    readonly stopsBatch: boolean,
    readonly usage?: TokenUsage
  ) {
    super(errorCode);
    this.name = "DeepSeekRequestError";
  }
}

function usageOf(value: z.infer<typeof ResponseSchema>): TokenUsage {
  return {
    promptTokens: value.usage?.prompt_tokens ?? 0,
    completionTokens: value.usage?.completion_tokens ?? 0,
    totalTokens: value.usage?.total_tokens ?? 0
  };
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function readLimitedResponseBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new DeepSeekRequestError("response_too_large", false, false);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await withAbort(reader.read(), signal);
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new DeepSeekRequestError("response_too_large", false, false);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    if (signal.aborted) void reader.cancel().catch(() => undefined);
    else reader.releaseLock();
  }
}

export class DeepSeekClient implements AnalysisClient {
  constructor(
    private readonly config: DeepSeekConfig,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
    private readonly sleep: Sleep = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs))
  ) {}

  async analyze(messages: Array<{ role: "system" | "user"; content: string }>): Promise<{
    result: unknown;
    usage: TokenUsage;
  }> {
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      try {
        return await this.request(messages);
      } catch (error) {
        const retryable = error instanceof DeepSeekRequestError && error.retryable;
        if (!retryable || attempt === this.config.maxRetries) throw error;
        await this.sleep(500 * 2 ** attempt);
      }
    }
    throw new DeepSeekRequestError("retry_exhausted", false, false);
  }

  private async request(messages: Array<{ role: "system" | "user"; content: string }>): Promise<{
    result: unknown;
    usage: TokenUsage;
  }> {
    const controller = new AbortController();
    const deadline = Date.now() + this.config.timeoutMs;
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await withAbort(this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          stream: false,
          response_format: { type: "json_object" },
          thinking: { type: "disabled" },
          temperature: 0.1,
          max_tokens: this.config.maxOutputTokens
        }),
        signal: controller.signal,
        redirect: "error"
      }), controller.signal);
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new DeepSeekRequestError(`http_${response.status}`, false, true);
        }
        if (response.status === 402) throw new DeepSeekRequestError("balance_unavailable", false, true);
        if (response.status === 429 || response.status >= 500) {
          throw new DeepSeekRequestError(`http_${response.status}`, true, false);
        }
        throw new DeepSeekRequestError(`http_${response.status}`, false, response.status === 400 || response.status === 404);
      }
      const responseText = await readLimitedResponseBody(response, this.config.maxResponseBytes, controller.signal);
      if (Date.now() > deadline) throw new DeepSeekRequestError("timeout", true, false);
      let payload: unknown;
      try {
        payload = JSON.parse(responseText);
      } catch {
        throw new DeepSeekRequestError("response_json_invalid", false, false);
      }
      if (Date.now() > deadline) throw new DeepSeekRequestError("timeout", true, false);
      const parsed = ResponseSchema.safeParse(payload);
      if (!parsed.success) {
        const looseUsage = z.object({ usage: ResponseSchema.shape.usage }).passthrough().safeParse(payload);
        throw new DeepSeekRequestError(
          "response_schema_invalid",
          false,
          false,
          looseUsage.success ? usageOf({ choices: [], usage: looseUsage.data.usage }) : undefined
        );
      }
      let result: unknown;
      const usage = usageOf(parsed.data);
      try {
        result = JSON.parse(parsed.data.choices[0]!.message.content);
      } catch {
        throw new AnalysisValidationError("invalid_json", usage);
      }
      if (Date.now() > deadline) throw new DeepSeekRequestError("timeout", true, false, usage);
      return { result, usage };
    } catch (error) {
      if (error instanceof DeepSeekRequestError || error instanceof AnalysisValidationError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new DeepSeekRequestError("timeout", true, false);
      }
      throw new DeepSeekRequestError("network_error", true, false);
    } finally {
      clearTimeout(timeout);
    }
  }
}
