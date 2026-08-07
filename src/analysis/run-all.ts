import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { runAnalysisBatch } from "./batch.js";
import type { DeepSeekConfig } from "./config.js";
import { DeepSeekClient } from "./deepseek-client.js";
import { MysqlAnalysisStore } from "./mysql-store.js";
import type { BatchSummary } from "./types.js";

const ANALYSIS_LOCK_NAME = "readtrace:content-analysis";
const RUN_LIMIT = 10;

export type AnalysisRunSource = "automatic" | "manual";

export interface UnifiedAnalysisSummary {
  source: AnalysisRunSource;
  status: "success" | "partial_success" | "failed";
  posts: BatchSummary;
  comments: BatchSummary;
}

export interface AnalysisRunStart {
  started: boolean;
  reason?: "already_running";
  completion?: Promise<UnifiedAnalysisSummary>;
}

interface LockRow extends RowDataPacket { acquired: number | null }

function emptySummary(): BatchSummary {
  return {
    processed: 0,
    succeeded: 0,
    skipped: 0,
    failed: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    errorCodes: {}
  };
}

async function releaseLock(connection: PoolConnection): Promise<void> {
  try {
    await connection.query("SELECT RELEASE_LOCK(?)", [ANALYSIS_LOCK_NAME]);
  } finally {
    connection.release();
  }
}

export async function startUnifiedAnalysis(input: {
  pool: Pool;
  config: DeepSeekConfig;
  source: AnalysisRunSource;
}): Promise<AnalysisRunStart> {
  const connection = await input.pool.getConnection();
  try {
    const [rows] = await connection.query<LockRow[]>("SELECT GET_LOCK(?, 0) AS acquired", [ANALYSIS_LOCK_NAME]);
    const acquired = rows[0]?.acquired;
    if (acquired === 0) {
      connection.release();
      return { started: false, reason: "already_running" };
    }
    if (acquired !== 1) throw new Error("analysis_lock_unavailable");
  } catch (error) {
    connection.release();
    throw error;
  }

  const completion = (async (): Promise<UnifiedAnalysisSummary> => {
    const store = new MysqlAnalysisStore(input.pool);
    const client = new DeepSeekClient(input.config);
    const limit = Math.min(RUN_LIMIT, input.config.batchLimit);
    let posts = emptySummary();
    let comments = emptySummary();
    try {
      posts = await runAnalysisBatch({ store, client, config: input.config, contentType: "POST", limit });
      if (posts.stoppedReason !== "NON_RECOVERABLE_ERROR") {
        comments = await runAnalysisBatch({ store, client, config: input.config, contentType: "COMMENT", limit });
      }
      const totalFailed = posts.failed + comments.failed;
      const totalSucceeded = posts.succeeded + comments.succeeded;
      return {
        source: input.source,
        status: totalFailed === 0 ? "success" : totalSucceeded > 0 ? "partial_success" : "failed",
        posts,
        comments
      };
    } finally {
      await releaseLock(connection);
    }
  })();
  return { started: true, completion };
}

export function safeRunSummary(summary: UnifiedAnalysisSummary): object {
  const compact = (batch: BatchSummary) => ({
    processed: batch.processed,
    succeeded: batch.succeeded,
    skipped: batch.skipped,
    failed: batch.failed,
    promptTokens: batch.promptTokens,
    completionTokens: batch.completionTokens,
    totalTokens: batch.totalTokens,
    errorCodes: batch.errorCodes,
    ...(batch.stoppedReason ? { stoppedReason: batch.stoppedReason } : {})
  });
  return { source: summary.source, status: summary.status, posts: compact(summary.posts), comments: compact(summary.comments) };
}
