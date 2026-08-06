import assert from "node:assert/strict";
import test from "node:test";
import type { DeepSeekConfig } from "../src/analysis/config.js";
import { DeepSeekClient, DeepSeekRequestError, type FetchLike } from "../src/analysis/deepseek-client.js";

const config: DeepSeekConfig = {
  apiKey: "test-only-secret",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  timeoutMs: 5_000,
  maxRetries: 2,
  batchLimit: 10,
  batchTokenBudget: 20_000,
  maxOutputTokens: 800,
  maxResponseBytes: 1_048_576,
  claimLeaseMs: 180_000,
  promptVersion: "content-analysis-v1"
};

function successResponse(): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ sentiment: "UNKNOWN" }) } }],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("DeepSeek客户端调用官方JSON接口并关闭思考模式", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const fetchImpl: FetchLike = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return successResponse();
  };
  const client = new DeepSeekClient(config, fetchImpl, async () => undefined);
  const response = await client.analyze([{ role: "user", content: "sample" }]);

  assert.equal(capturedUrl, "https://api.deepseek.com/chat/completions");
  const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
  assert.equal(body.model, "deepseek-v4-flash");
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 800);
  assert.equal(capturedInit?.redirect, "error");
  assert.equal((capturedInit?.headers as Record<string, string>).Authorization, "Bearer test-only-secret");
  assert.deepEqual(response.usage, { promptTokens: 12, completionTokens: 3, totalTokens: 15 });
});

test("限流和服务异常有限重试并使用递增等待", async () => {
  const statuses = [429, 500, 200];
  const waits: number[] = [];
  const fetchImpl: FetchLike = async () => {
    const status = statuses.shift()!;
    return status === 200 ? successResponse() : new Response("sensitive upstream body", { status });
  };
  const client = new DeepSeekClient(config, fetchImpl, async (duration) => { waits.push(duration); });
  await client.analyze([{ role: "user", content: "sample" }]);
  assert.deepEqual(waits, [500, 1_000]);
  assert.equal(statuses.length, 0);
});

test("鉴权失败立即停止且错误不复制密钥或上游正文", async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    return new Response("test-only-secret sensitive upstream body", { status: 401 });
  };
  const client = new DeepSeekClient(config, fetchImpl, async () => undefined);
  await assert.rejects(
    () => client.analyze([{ role: "user", content: "sample" }]),
    (error: unknown) => error instanceof DeepSeekRequestError
      && error.errorCode === "http_401"
      && error.stopsBatch
      && !error.message.includes("test-only-secret")
      && !error.message.includes("sensitive upstream body")
  );
  assert.equal(calls, 1);
});

test("响应体超过字节上限时安全失败且不解析正文", async () => {
  const fetchImpl: FetchLike = async () => new Response("x".repeat(100), {
    status: 200,
    headers: { "Content-Length": "100" }
  });
  const client = new DeepSeekClient({ ...config, maxResponseBytes: 50 }, fetchImpl, async () => undefined);
  await assert.rejects(
    () => client.analyze([{ role: "user", content: "sample" }]),
    (error: unknown) => error instanceof DeepSeekRequestError && error.errorCode === "response_too_large"
  );
});

test("超时覆盖响应体读取阶段", async () => {
  const fetchImpl: FetchLike = async (_input, init) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
      }
    });
    return new Response(stream, { status: 200 });
  };
  const client = new DeepSeekClient({ ...config, timeoutMs: 20, maxRetries: 0 }, fetchImpl, async () => undefined);
  await assert.rejects(
    () => client.analyze([{ role: "user", content: "sample" }]),
    (error: unknown) => error instanceof DeepSeekRequestError && error.errorCode === "timeout"
  );
});
