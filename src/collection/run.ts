import type { Pool } from "mysql2/promise";
import { CollectionPersistenceService, type CreatedApiTask } from "../db/persistence/index.js";
import {
  JustOneApiClient,
  JustOneApiRequestError,
  type ApiEnvelope
} from "../justoneapi-probe/client.js";
import { normalizeCommentPage, normalizeNoteDetail, selectRelatedSearchNotes } from "../justoneapi-probe/normalize.js";
import type { Comment } from "../xhs-probe/types.js";

const SEARCH_PATH = "/api/xiaohongshu/search-note/v4";
const DETAIL_PATH = "/api/xiaohongshu/get-note-detail/v1";
const COMMENT_PATH = "/api/xiaohongshu/get-note-comment/v2";
export const DEFAULT_MAX_COMMENT_PAGES = 20;
export const DEFAULT_MAX_COMMENTS_PER_NOTE = 1_000;

export interface CommentPagination {
  hasMore: boolean;
  cursor: string | null;
}

export interface CollectedCommentPages {
  comments: Comment[];
  pageCount: number;
  truncated: boolean;
  stopped: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function readCommentPagination(data: unknown): CommentPagination {
  const page = record(data);
  const cursor = typeof page?.cursor === "string" && page.cursor.trim() ? page.cursor.trim() : null;
  return { hasMore: page?.has_more === true, cursor };
}

export async function collectCommentPages(input: {
  noteId: string;
  fetchPage: (cursor: string | null) => Promise<ApiEnvelope>;
  shouldStop?: () => Promise<boolean>;
  maxPages?: number;
  maxComments?: number;
}): Promise<CollectedCommentPages> {
  const maxPages = input.maxPages ?? DEFAULT_MAX_COMMENT_PAGES;
  const maxComments = input.maxComments ?? DEFAULT_MAX_COMMENTS_PER_NOTE;
  if (!Number.isSafeInteger(maxPages) || maxPages <= 0 || !Number.isSafeInteger(maxComments) || maxComments <= 0) {
    throw new Error("comment_pagination_limit_invalid");
  }
  const comments = new Map<string, Comment>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let pageCount = 1; pageCount <= maxPages; pageCount += 1) {
    const response = await input.fetchPage(cursor);
    const pageComments = normalizeCommentPage(response.data, input.noteId);
    for (const comment of pageComments) {
      if (!comments.has(comment.commentId) && comments.size < maxComments) comments.set(comment.commentId, comment);
    }
    if (await input.shouldStop?.() === true) {
      return { comments: [...comments.values()], pageCount, truncated: false, stopped: true };
    }
    const pagination = readCommentPagination(response.data);
    const exceededCommentLimit = comments.size >= maxComments
      && (pageComments.some((comment) => !comments.has(comment.commentId)) || pagination.hasMore);
    if (exceededCommentLimit) return { comments: [...comments.values()], pageCount, truncated: true, stopped: false };
    if (!pagination.hasMore) return { comments: [...comments.values()], pageCount, truncated: false, stopped: false };
    if (!pagination.cursor || seenCursors.has(pagination.cursor)) {
      return { comments: [...comments.values()], pageCount, truncated: true, stopped: false };
    }
    if (pageCount === maxPages) return { comments: [...comments.values()], pageCount, truncated: true, stopped: false };
    seenCursors.add(pagination.cursor);
    cursor = pagination.cursor;
  }
  return { comments: [...comments.values()], pageCount: maxPages, truncated: true, stopped: false };
}

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
    const errorCode = safeErrorCode(error);
    try {
      await service.tasks.failApiTask(input.task.taskId, errorCode);
    } catch (settlementError) {
      if (await service.tasks.shouldStop(input.task.taskId).catch(() => false)) {
        await service.tasks.finishStopped(input.task.taskId).catch(() => undefined);
        return { taskId: input.task.taskId, status: "STOPPED", ...progress, errorCode: null };
      }
      throw settlementError;
    }
    return { taskId: input.task.taskId, status: "FAILED", ...progress, errorCode };
  }

  const client = new JustOneApiClient({
    token: input.justOneApiToken,
    baseUrl: input.baseUrl ?? "https://api.justoneapi.com",
    timeoutMs: input.timeoutMs ?? 120_000
  });

  try {
    const candidates = new Map<string, {
      note: Record<string, unknown>;
      matches: Array<{ searchTermId: number; matchedTermSnapshot: string }>;
    }>();
    for (const searchTerm of input.task.searchTerms) {
      try {
        const search = await call(client, SEARCH_PATH, {
          keyword: searchTerm.keyword,
          page: 1,
          sortType: "time_descending",
          noteType: "ALL",
          timeFilter: "ONE_WEEK"
        });
        const notes = selectRelatedSearchNotes(search.data, searchTerm.keyword, input.task.noteLimit);
        for (const note of notes) {
          const noteId = noteIdOf(note);
          if (!noteId) continue;
          const existing = candidates.get(noteId);
          const match = { searchTermId: searchTerm.searchTermId, matchedTermSnapshot: searchTerm.keyword };
          if (existing) existing.matches.push(match);
          else candidates.set(noteId, { note, matches: [match] });
        }
      } catch (error) {
        if (error instanceof JustOneApiRequestError && error.code === "authentication_failed") throw error;
        progress.failedCount += 1;
        await service.tasks.addProgress(input.task.taskId, { failedCount: 1 });
      }
      const stoppedAfterSearch = await stopIfRequested(service, input.task.taskId, progress);
      if (stoppedAfterSearch) return stoppedAfterSearch;
    }
    progress.fetchedPostCount += candidates.size;
    await service.tasks.addProgress(input.task.taskId, { fetchedPostCount: candidates.size });

    let commentsTruncated = false;
    for (const { note, matches } of candidates.values()) {
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
        const post = normalizeNoteDetail(detail.data, matches[0]!.matchedTermSnapshot);
        if (!post) {
          progress.failedCount += 1;
          await service.tasks.addProgress(input.task.taskId, { failedCount: 1 });
          continue;
        }

        const commentPages = await collectCommentPages({
          noteId,
          shouldStop: () => service.tasks.shouldStop(input.task.taskId),
          fetchPage: (cursor) => call(client, COMMENT_PATH, {
            noteId,
            sort: "latest",
            ...(cursor === null ? {} : { cursor })
          })
        });
        const comments = commentPages.comments;
        progress.fetchedCommentCount += comments.length;
        await service.tasks.addProgress(input.task.taskId, { fetchedCommentCount: comments.length });
        if (commentPages.truncated) {
          commentsTruncated = true;
          progress.failedCount += 1;
          await service.tasks.addProgress(input.task.taskId, { failedCount: 1 });
        }
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
              matches,
              observedAt: new Date(),
              rawPayload: detail.data
            }
          );
          progress.storedPostCount += persisted.storedPostCount;
          progress.storedCommentCount += persisted.storedCommentCount;
          await service.tasks.addProgress(input.task.taskId, persisted);
        }
        if (commentPages.stopped) {
          await service.tasks.finishStopped(input.task.taskId).catch(() => undefined);
          return { taskId: input.task.taskId, status: "STOPPED", ...progress, errorCode: null };
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
    const errorCode = commentsTruncated
      ? "comment_collection_truncated"
      : progress.failedCount > 0 ? "collection_item_failed" : null;
    await service.tasks.finishApiTask(input.task.taskId, status, errorCode);
    return {
      taskId: input.task.taskId,
      status: status.toUpperCase() as CollectionRunSummary["status"],
      ...progress,
      errorCode
    };
  } catch (error) {
    const errorCode = safeErrorCode(error);
    try {
      await service.tasks.failApiTask(input.task.taskId, errorCode);
    } catch (settlementError) {
      if (await service.tasks.shouldStop(input.task.taskId).catch(() => false)) {
        await service.tasks.finishStopped(input.task.taskId).catch(() => undefined);
        return { taskId: input.task.taskId, status: "STOPPED", ...progress, errorCode: null };
      } else {
        throw settlementError;
      }
    }
    return { taskId: input.task.taskId, status: "FAILED", ...progress, errorCode };
  }
}

export function safeCollectionRunSummary(summary: CollectionRunSummary): CollectionRunSummary {
  return { ...summary };
}
