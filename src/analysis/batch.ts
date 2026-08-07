import { createHash, randomUUID } from "node:crypto";
import type { DeepSeekConfig } from "./config.js";
import { DeepSeekRequestError } from "./deepseek-client.js";
import { buildAnalysisMessages, estimateMessageTokens } from "./prompt.js";
import { AnalysisValidationError, parseAnalysisResult } from "./schema.js";
import type {
  AnalysisCandidate,
  AnalysisClient,
  AnalysisContentType,
  AnalysisRequest,
  AnalysisStore,
  BatchSummary,
  ClassificationItem
} from "./types.js";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function digestCandidate(candidate: AnalysisCandidate): string {
  return digest(candidate);
}

export function digestTaxonomy(items: ClassificationItem[]): string {
  return digest([...items].sort((left, right) => left.id.localeCompare(right.id)));
}

export function makeIdempotencyKey(request: Omit<AnalysisRequest, "idempotencyKey">): string {
  return digest({
    contentType: request.candidate.contentType,
    contentId: request.candidate.contentId,
    inputDigest: request.inputDigest,
    modelName: request.modelName,
    promptVersion: request.promptVersion,
    taxonomyDigest: request.taxonomyDigest
  });
}

function errorCodeOf(error: unknown): string {
  if (error instanceof DeepSeekRequestError || error instanceof AnalysisValidationError) return error.errorCode;
  return "internal_error";
}

export async function runAnalysisBatch(input: {
  store: AnalysisStore;
  client: AnalysisClient;
  config: DeepSeekConfig;
  contentType: AnalysisContentType;
  limit: number;
}): Promise<BatchSummary> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > input.config.batchLimit) {
    throw new Error("analysis_limit_invalid");
  }
  const taxonomy = await input.store.listEnabledClassifications();
  const taxonomyDigest = digestTaxonomy(taxonomy);
  const summary: BatchSummary = {
    processed: 0, succeeded: 0, skipped: 0, failed: 0,
    promptTokens: 0, completionTokens: 0, totalTokens: 0, errorCodes: {}
  };
  const pageSize = Math.max(50, input.limit);
  const seen = new Set<string>();
  let beforeId: string | undefined;
  let exhausted = false;
  let budgetConsumed = 0;
  while (summary.processed < input.limit && !exhausted) {
    const candidates = await input.store.listCandidates(input.contentType, pageSize, beforeId);
    if (candidates.length < pageSize) exhausted = true;
    beforeId = candidates.at(-1)?.contentId;
    for (const candidate of candidates) {
      const candidateKey = `${candidate.contentType}:${candidate.contentId}`;
      if (seen.has(candidateKey)) {
        exhausted = true;
        continue;
      }
      seen.add(candidateKey);
      if (!candidate.text?.trim()) {
        summary.skipped += 1;
        continue;
      }
      const requestWithoutKey = {
        inputDigest: digestCandidate(candidate), taxonomyDigest,
        promptVersion: input.config.promptVersion, modelName: input.config.model, candidate
      };
      const request: AnalysisRequest = {
        ...requestWithoutKey,
        idempotencyKey: makeIdempotencyKey(requestWithoutKey)
      };
      if (await input.store.hasSuccessfulResult(request.idempotencyKey)) {
        summary.skipped += 1;
        continue;
      }
      if (summary.processed >= input.limit) break;
      const messages = buildAnalysisMessages(candidate, taxonomy);
      const estimatedTokens = estimateMessageTokens(messages, input.config.maxOutputTokens);
      if (budgetConsumed + estimatedTokens > input.config.batchTokenBudget) {
        summary.stoppedReason = "TOKEN_BUDGET_EXHAUSTED";
        exhausted = true;
        break;
      }
      const ownerToken = randomUUID();
      if (!await input.store.startAttempt(request, ownerToken, input.config.claimLeaseMs)) {
        summary.skipped += 1;
        continue;
      }
      summary.processed += 1;
      let failureUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
      let stopsBatch = false;
      try {
        const response = await input.client.analyze(messages);
        failureUsage = response.usage;
        const result = parseAnalysisResult(response.result, taxonomy);
        await input.store.saveSuccess(request, ownerToken, result, response.usage);
        summary.succeeded += 1;
        summary.promptTokens += response.usage.promptTokens;
        summary.completionTokens += response.usage.completionTokens;
        summary.totalTokens += response.usage.totalTokens;
      } catch (error) {
        const code = errorCodeOf(error);
        if ((error instanceof AnalysisValidationError || error instanceof DeepSeekRequestError) && error.usage) {
          failureUsage = error.usage;
        }
        await input.store.saveFailure(request, ownerToken, code, code, failureUsage);
        summary.failed += 1;
        if (failureUsage) {
          summary.promptTokens += failureUsage.promptTokens;
          summary.completionTokens += failureUsage.completionTokens;
          summary.totalTokens += failureUsage.totalTokens;
        }
        summary.errorCodes[code] = (summary.errorCodes[code] ?? 0) + 1;
        if (error instanceof DeepSeekRequestError && error.stopsBatch) {
          stopsBatch = true;
        }
      } finally {
        budgetConsumed += Math.max(estimatedTokens, failureUsage?.totalTokens ?? 0);
      }
      if (stopsBatch) {
        summary.stoppedReason = "NON_RECOVERABLE_ERROR";
        exhausted = true;
        break;
      }
      if (budgetConsumed >= input.config.batchTokenBudget) {
        summary.stoppedReason = "TOKEN_BUDGET_EXHAUSTED";
        exhausted = true;
        break;
      }
    }
  }
  return summary;
}
