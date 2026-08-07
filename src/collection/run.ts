import type { Pool } from "mysql2/promise";
import { CollectionPersistenceService, type CreatedApiTask } from "../db/persistence/index.js";
import {
  JustOneApiClient,
  JustOneApiRequestError,
  type ApiEnvelope
} from "../justoneapi-probe/client.js";
import { normalizeCommentPage, normalizeNoteDetail, selectRelatedSearchNotes } from "../justoneapi-probe/normalize.js";

const SEARCH_PATH = "/api/xiaohongshu/search-note/v4";
const DETAIL_PATH = "/api/xiaohongshu/get-note-detail/v1";
const COMMENT_PATH = "/api/xiaohongshu/get-note-comment/v2";

export interface CollectionRunSummary {
  taskId: number;
  status: "SUCCESS" | "PARTIAL_SUCCESS" | "FAILED" | "STOPPED";
  fetchedPostCount: number;
  fetchedCommentCount: number;
  storedPostCount: number;
  storedCommentCount: number;
  skippedNoCommentPostCount: number;
  failedCount: number;
  errorCode: string | null;
}

interface MutableProgress {
  fetchedPostCount: number;
  fetchedCommentCount: number;
  storedPostCount: number;
  storedCommentCount: number;
  skippedNoCommentPostCount: number;
  failedCount: number;
}

function emptyProgress(): MutableProgress {
  return {
    fetchedPostCount: 0,
    fetchedCommentCount: 0,
    storedPostCount: 0,
    storedCommentCount: 0,
    skippedNoCommentPostCount: 0,
    failedCount: 0
  };
}

function noteIdOf(value: Record<string, unknown>): string | null {
  for (const key of ["noteId", "note_id", "id"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof JustOneApiRequestError) return error.code;
  return "collection_processing_failed";
}

async function stopIfRequested(
  service: CollectionPersistenceService,
  taskId: number,
  progress: MutableProgress
): Promise<CollectionRunSummary | null> {
  if (!(await service.tasks.shouldStop(taskId))) return null;
  await service.tasks.finishStopped(taskId).catch(() => undefined);
  return { taskId, status: "STOPPED", ...progress, errorCode: null };
}

async function call(client: JustOneApiClient, pathname: string, params: Record<string, string | number>): Promise<ApiEnvelope> {
  return client.get(pathname, params);
}

export async function runCollectionTask(input: {
  pool: Pool;
  task: CreatedApiTask;
  justOneApiToken: string;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<CollectionRunSummary> {
  const progress = emptyProgress();
  const service = new CollectionPersistenceService(input.pool);
  try {
    await service.tasks.startTask(input.task.taskId, input.task.dataSourceId, input.task.brandId);
  } catch (error) {
    if (await service.tasks.shouldStop(input.task.taskId).catch(() => false)) {
      return { taskId: input.task.taskId, status: "STOPPED", ...progress, errorCode: null };
    }
    throw error;
  }

  const client = new JustOneApiClient({
    token: input.justOneApiToken,
    baseUrl: input.baseUrl ?? "https://api.justoneapi.com",
    timeoutMs: input.timeoutMs ?? 120_000
  });

  try {
    const search = await call(client, SEARCH_PATH, {
      keyword: input.task.keyword,
      page: 1,
      sortType: "time_descending",
      noteType: "ALL",
      timeFilter: "ONE_WEEK"
    });
    const notes = selectRelatedSearchNotes(search.data, input.task.keyword, input.task.noteLimit);
    progress.fetchedPostCount += notes.length;
    await service.tasks.addProgress(input.task.taskId, { fetchedPostCount: notes.length });
    const stoppedAfterSearch = await stopIfRequested(service, input.task.taskId, progress);
    if (stoppedAfterSearch) return stoppedAfterSearch;

    for (const note of notes) {
      const noteId = noteIdOf(note);
      if (!noteId) {
        progress.failedCount += 1;
        await service.tasks.addProgress(input.task.taskId, { failedCount: 1 });
        continue;
      }
      try {
        const detail = await call(client, DETAIL_PATH, { noteId });
        const stoppedAfterDetail = await stopIfRequested(service, input.task.taskId, progress);
        if (stoppedAfterDetail) return stoppedAfterDetail;
        const post = normalizeNoteDetail(detail.data, input.task.keyword);
        if (!post) {
          progress.failedCount += 1;
          await service.tasks.addProgress(input.task.taskId, { failedCount: 1 });
          continue;
        }

        const commentPage = await call(client, COMMENT_PATH, { noteId, sort: "latest" });
        const comments = normalizeCommentPage(commentPage.data, noteId);
        progress.fetchedCommentCount += comments.length;
        await service.tasks.addProgress(input.task.taskId, { fetchedCommentCount: comments.length });
        if (comments.length === 0) {
          progress.skippedNoCommentPostCount += 1;
          await service.tasks.addProgress(input.task.taskId, { skippedNoCommentPostCount: 1 });
        } else {
          const persisted = await service.persistItem(
            input.task.taskId,
            input.task.dataSourceId,
            input.task.brandId,
            {
              post,
              comments: comments.map((comment) => ({ ...comment, rawPayload: comment })),
              matches: [{ searchTermId: input.task.searchTermId, matchedTermSnapshot: input.task.keyword }],
              observedAt: new Date(),
              rawPayload: detail.data
            }
          );
          progress.storedPostCount += persisted.storedPostCount;
          progress.storedCommentCount += persisted.storedCommentCount;
          await service.tasks.addProgress(input.task.taskId, persisted);
        }
        const stoppedAfterComments = await stopIfRequested(service, input.task.taskId, progress);
        if (stoppedAfterComments) return stoppedAfterComments;
      } catch (error) {
        if (error instanceof JustOneApiRequestError && error.code === "authentication_failed") throw error;
        progress.failedCount += 1;
        await service.tasks.addProgress(input.task.taskId, { failedCount: 1 });
        const stoppedAfterFailure = await stopIfRequested(service, input.task.taskId, progress);
        if (stoppedAfterFailure) return stoppedAfterFailure;
      }
    }

    const status = progress.failedCount === 0
      ? "success"
      : progress.storedPostCount > 0 || progress.skippedNoCommentPostCount > 0
        ? "partial_success"
        : "failed";
    const errorCode = progress.failedCount > 0 ? "collection_item_failed" : null;
    await service.tasks.finishApiTask(input.task.taskId, status, errorCode);
    return {
      taskId: input.task.taskId,
      status: status.toUpperCase() as CollectionRunSummary["status"],
      ...progress,
      errorCode
    };
  } catch (error) {
    const errorCode = safeErrorCode(error);
    await service.tasks.finishApiTask(input.task.taskId, "failed", errorCode).catch(async () => {
      if (await service.tasks.shouldStop(input.task.taskId).catch(() => false)) {
        await service.tasks.finishStopped(input.task.taskId).catch(() => undefined);
      }
    });
    return { taskId: input.task.taskId, status: "FAILED", ...progress, errorCode };
  }
}

export function safeCollectionRunSummary(summary: CollectionRunSummary): CollectionRunSummary {
  return { ...summary };
}
