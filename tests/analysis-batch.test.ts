import assert from "node:assert/strict";
import test from "node:test";
import { runAnalysisBatch } from "../src/analysis/batch.js";
import type { DeepSeekConfig } from "../src/analysis/config.js";
import { DeepSeekRequestError } from "../src/analysis/deepseek-client.js";
import { buildAnalysisMessages, estimateMessageTokens } from "../src/analysis/prompt.js";
import { AnalysisValidationError } from "../src/analysis/schema.js";
import type {
  AnalysisCandidate,
  AnalysisClient,
  AnalysisRequest,
  AnalysisResult,
  AnalysisStore,
  ClassificationItem,
  TokenUsage
} from "../src/analysis/types.js";

const config: DeepSeekConfig = {
  apiKey: "test-only-secret",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  timeoutMs: 5_000,
  maxRetries: 0,
  batchLimit: 10,
  batchTokenBudget: 20_000,
  maxOutputTokens: 800,
  maxResponseBytes: 1_048_576,
  claimLeaseMs: 180_000,
  promptVersion: "content-analysis-v1"
};

const taxonomy: ClassificationItem[] = [
  { id: "1", classificationType: "CATEGORY", code: "washing_machine", displayName: "洗衣机", description: null, version: 1 },
  { id: "2", classificationType: "PROBLEM_TYPE", code: "noise", displayName: "噪音", description: null, version: 1 },
  { id: "3", classificationType: "TOPIC", code: "noise_experience", displayName: "噪音体验", description: null, version: 1 }
];

function candidate(contentId: string): AnalysisCandidate {
  return {
    contentType: "POST",
    contentId,
    postId: contentId,
    title: `样本${contentId}`,
    text: "运行声音偏大",
    tags: [],
    brandNames: ["Leader"],
    postTitle: null,
    postContext: null,
    parentCommentText: null
  };
}

function validResult(): AnalysisResult {
  return {
    sentiment: "NEGATIVE",
    contentNature: "使用反馈",
    problemTypeIds: ["2"],
    categoryId: "1",
    productSeries: null,
    productModel: null,
    userStage: "使用中",
    riskLevel: "WATCH",
    confidence: "HIGH",
    topicIds: ["3"]
  };
}

function storeFor(candidates: AnalysisCandidate[], successfulKeys = new Set<string>()): {
  store: AnalysisStore;
  started: AnalysisRequest[];
  saved: AnalysisResult[];
  failures: string[];
  failureUsages: Array<TokenUsage | undefined>;
} {
  const started: AnalysisRequest[] = [];
  const saved: AnalysisResult[] = [];
  const failures: string[] = [];
  const failureUsages: Array<TokenUsage | undefined> = [];
  return {
    started,
    saved,
    failures,
    failureUsages,
    store: {
      async listEnabledClassifications() { return taxonomy; },
      async listCandidates(_type, limit) { return candidates.slice(0, limit); },
      async hasSuccessfulResult(key) { return successfulKeys.has(key); },
      async startAttempt(request) { started.push(request); return true; },
      async saveSuccess(_request, _ownerToken, result) { saved.push(result); },
      async saveFailure(_request, _ownerToken, errorCode, _summary, usage) {
        failures.push(errorCode);
        failureUsages.push(usage);
      }
    }
  };
}

test("批处理保存严格分类结果和Token用量", async () => {
  const state = storeFor([candidate("10"), candidate("11")]);
  const usage: TokenUsage = { promptTokens: 20, completionTokens: 5, totalTokens: 25 };
  const client: AnalysisClient = { async analyze() { return { result: validResult(), usage }; } };
  const summary = await runAnalysisBatch({ store: state.store, client, config, contentType: "POST", limit: 2 });

  assert.deepEqual(summary, {
    processed: 2,
    succeeded: 2,
    skipped: 0,
    failed: 0,
    promptTokens: 40,
    completionTokens: 10,
    totalTokens: 50,
    errorCodes: {}
  });
  assert.equal(state.started.length, 2);
  assert.equal(state.saved.length, 2);
  assert.equal(state.failures.length, 0);
  assert.equal(state.started[0]!.idempotencyKey.length, 64);
});

test("相同幂等键跳过模型调用和写入", async () => {
  const firstState = storeFor([candidate("10")]);
  const firstClient: AnalysisClient = { async analyze() { return { result: validResult(), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }; } };
  await runAnalysisBatch({ store: firstState.store, client: firstClient, config, contentType: "POST", limit: 1 });
  const key = firstState.started[0]!.idempotencyKey;

  const secondState = storeFor([candidate("10")], new Set([key]));
  let calls = 0;
  const secondClient: AnalysisClient = { async analyze() { calls += 1; throw new Error("must_not_call"); } };
  const summary = await runAnalysisBatch({ store: secondState.store, client: secondClient, config, contentType: "POST", limit: 1 });
  assert.equal(summary.skipped, 1);
  assert.equal(summary.processed, 0);
  assert.equal(calls, 0);
  assert.equal(secondState.started.length, 0);
});

test("非法模型结果只标记当前内容失败并继续下一条", async () => {
  const state = storeFor([candidate("10"), candidate("11")]);
  let calls = 0;
  const client: AnalysisClient = {
    async analyze() {
      calls += 1;
      return {
        result: calls === 1 ? { ...validResult(), categoryId: "999" } : validResult(),
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }
      };
    }
  };
  const summary = await runAnalysisBatch({ store: state.store, client, config, contentType: "POST", limit: 2 });
  assert.equal(summary.failed, 1);
  assert.equal(summary.succeeded, 1);
  assert.deepEqual(state.failures, ["taxonomy_id_invalid"]);
  assert.equal(state.saved.length, 1);
});

test("鉴权失败停止后续内容但保留当前失败记录", async () => {
  const state = storeFor([candidate("10"), candidate("11")]);
  let calls = 0;
  const client: AnalysisClient = {
    async analyze() {
      calls += 1;
      throw new DeepSeekRequestError("http_401", false, true);
    }
  };
  const summary = await runAnalysisBatch({ store: state.store, client, config, contentType: "POST", limit: 2 });
  assert.equal(calls, 1);
  assert.equal(summary.processed, 1);
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.errorCodes, { http_401: 1 });
});

test("没有取得原子租约时不调用模型", async () => {
  const state = storeFor([candidate("10")]);
  state.store.startAttempt = async () => false;
  let calls = 0;
  const client: AnalysisClient = { async analyze() { calls += 1; throw new Error("must_not_call"); } };
  const summary = await runAnalysisBatch({ store: state.store, client, config, contentType: "POST", limit: 1 });
  assert.equal(calls, 0);
  assert.equal(summary.processed, 0);
  assert.equal(summary.skipped, 1);
});

test("预计Token超过整批预算时停止且不领取任务", async () => {
  const state = storeFor([candidate("10")]);
  let calls = 0;
  const client: AnalysisClient = { async analyze() { calls += 1; throw new Error("must_not_call"); } };
  const limitedConfig = { ...config, batchTokenBudget: 100 };
  const summary = await runAnalysisBatch({ store: state.store, client, config: limitedConfig, contentType: "POST", limit: 1 });
  assert.equal(calls, 0);
  assert.equal(state.started.length, 0);
  assert.equal(summary.stoppedReason, "TOKEN_BUDGET_EXHAUSTED");
});

test("键集分页能够越过最近已分析内容继续处理更早内容", async () => {
  const recent = Array.from({ length: 50 }, (_, index) => candidate(String(100 - index)));
  const older = candidate("50");
  const beforeIds: Array<string | undefined> = [];
  let successChecks = 0;
  let modelCalls = 0;
  const state = storeFor([]);
  state.store.listCandidates = async (_type, _limit, beforeId) => {
    beforeIds.push(beforeId);
    return beforeId === undefined ? recent : [older];
  };
  state.store.hasSuccessfulResult = async () => {
    successChecks += 1;
    return successChecks <= recent.length;
  };
  const client: AnalysisClient = {
    async analyze() {
      modelCalls += 1;
      return { result: validResult(), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  };
  const summary = await runAnalysisBatch({ store: state.store, client, config, contentType: "POST", limit: 1 });
  assert.deepEqual(beforeIds, [undefined, "51"]);
  assert.equal(summary.skipped, 50);
  assert.equal(summary.succeeded, 1);
  assert.equal(modelCalls, 1);
});

test("模型JSON非法时仍记录API已经报告的Token用量", async () => {
  const state = storeFor([candidate("10")]);
  const usage = { promptTokens: 9, completionTokens: 4, totalTokens: 13 };
  const client: AnalysisClient = { async analyze() { throw new AnalysisValidationError("invalid_json", usage); } };
  const summary = await runAnalysisBatch({ store: state.store, client, config, contentType: "POST", limit: 1 });
  assert.deepEqual(state.failureUsages, [usage]);
  assert.equal(summary.totalTokens, 13);
  assert.equal(summary.failed, 1);
});

test("上游缺失usage时仍按保守估算扣减批预算", async () => {
  const samples = [candidate("10"), candidate("11")];
  const estimate = estimateMessageTokens(buildAnalysisMessages(samples[0]!, taxonomy), config.maxOutputTokens);
  const state = storeFor(samples);
  let calls = 0;
  const client: AnalysisClient = {
    async analyze() {
      calls += 1;
      return { result: validResult(), usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    }
  };
  const summary = await runAnalysisBatch({
    store: state.store,
    client,
    config: { ...config, batchTokenBudget: estimate * 2 - 1 },
    contentType: "POST",
    limit: 2
  });
  assert.equal(calls, 1);
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.stoppedReason, "TOKEN_BUDGET_EXHAUSTED");
});
