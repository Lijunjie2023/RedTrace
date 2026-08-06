import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { JustOneApiClient, type ApiEnvelope } from "./client.js";
import { loadJustOneApiConfig } from "./config.js";
import { parseProbeOptions } from "./options.js";
import { sanitizeApiValue } from "./sanitize.js";
import { normalizeCommentPage, normalizeNoteDetail, selectRelatedSearchNotes } from "./normalize.js";
import type { Comment, Post, ProbeReport } from "../xhs-probe/types.js";

function arrays(value: unknown): unknown[][] {
  if (Array.isArray(value)) return [value, ...value.flatMap(arrays)];
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(arrays);
  return [];
}

function idOf(value: unknown, names: string[]): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const name of names) if (typeof record[name] === "string" && record[name]) return record[name] as string;
  return null;
}

function objectsFromLargestArray(data: unknown): Record<string, unknown>[] {
  const candidates = arrays(data).filter((items) => items.some((item) => item && typeof item === "object"));
  const selected = candidates.sort((a, b) => b.length - a.length)[0] ?? [];
  return selected.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const options = parseProbeOptions(process.argv.slice(2));
  const client = new JustOneApiClient(loadJustOneApiConfig());
  const calls: Array<{ endpoint: string; ok: boolean; error?: string }> = [];
  const snapshots: Record<string, unknown> = {};
  const call = async (name: string, endpoint: string, params: Record<string, string | number>): Promise<ApiEnvelope | null> => {
    try {
      const result = await client.get(endpoint, params);
      calls.push({ endpoint, ok: true });
      snapshots[name] = sanitizeApiValue(result);
      return result;
    } catch (error) {
      calls.push({ endpoint, ok: false, error: error instanceof Error ? error.message : "unknown" });
      return null;
    }
  };

  const search = await call("search", "/api/xiaohongshu/search-note/v4", { keyword: options.keyword, page: 1, sortType: "time_descending", noteType: "ALL", timeFilter: "ONE_WEEK" });
  const rawSearchNotes = Array.isArray((search?.data as { notes?: unknown[] } | undefined)?.notes)
    ? (search?.data as { notes: unknown[] }).notes : [];
  const notes = selectRelatedSearchNotes(search?.data, options.keyword, options.noteLimit);
  const posts: Post[] = [];
  const commentsById = new Map<string, Comment>();
  let commentsBeforeDeduplication = 0;
  let repliesFetched = 0;
  for (let index = 0; index < notes.length; index += 1) {
    const noteId = idOf(notes[index], ["noteId", "note_id", "id"]);
    if (!noteId) continue;
    const detail = await call(`note-${index + 1}`, "/api/xiaohongshu/get-note-detail/v1", { noteId });
    const post = normalizeNoteDetail(detail?.data, options.keyword);
    if (post) posts.push(post);
    const commentPage = await call(`comments-${index + 1}`, "/api/xiaohongshu/get-note-comment/v2", { noteId, sort: "latest" });
    const normalizedComments = normalizeCommentPage(commentPage?.data, noteId);
    commentsBeforeDeduplication += normalizedComments.length;
    for (const comment of normalizedComments) if (!commentsById.has(comment.commentId)) commentsById.set(comment.commentId, comment);
    for (const comment of objectsFromLargestArray(commentPage?.data)) {
      if (repliesFetched >= options.replyLimit) break;
      const commentId = idOf(comment, ["commentId", "comment_id", "id"]);
      const subCommentCount = Number(comment.sub_comment_count ?? comment.subCommentCount ?? 0);
      if (!commentId || !Number.isFinite(subCommentCount) || subCommentCount <= 0) continue;
      repliesFetched += 1;
      await call(`replies-${repliesFetched}`, "/api/xiaohongshu/get-note-sub-comment/v2", { noteId, commentId });
    }
  }

  const runId = startedAt.toISOString().replace(/[:.]/g, "-");
  const outputDir = path.resolve("artifacts", "xhs-probe", runId);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, "responses.json"), JSON.stringify(snapshots, null, 2), "utf8");
  const finishedAt = new Date();
  const normalizedComments = [...commentsById.values()];
  const probeReport: ProbeReport = {
    runId,
    keyword: options.keyword,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    status: search ? (calls.every((item) => item.ok) ? "success" : "partial_success") : "failed",
    limits: { searchResults: rawSearchNotes.length, details: options.noteLimit, detailDelayMs: 0 },
    counts: {
      rawSearchResults: rawSearchNotes.length,
      relatedSearchResults: notes.length,
      postsBeforeDeduplication: posts.length,
      postsAfterDeduplication: new Set(posts.map((post) => post.noteId)).size,
      commentsBeforeDeduplication,
      commentsAfterDeduplication: normalizedComments.length
    },
    fieldCoverage: {}, flags: [], errors: []
  };
  await Promise.all([
    fs.writeFile(path.join(outputDir, "posts.json"), JSON.stringify(posts, null, 2), "utf8"),
    fs.writeFile(path.join(outputDir, "comments.json"), JSON.stringify(normalizedComments, null, 2), "utf8"),
    fs.writeFile(path.join(outputDir, "report.json"), JSON.stringify(probeReport, null, 2), "utf8")
  ]);
  const report = { status: probeReport.status, startedAt: probeReport.startedAt, options, calls, discoveredCandidates: notes.length, normalizedPostCount: posts.length, normalizedCommentCount: normalizedComments.length, repliesFetched };
  console.log(JSON.stringify({ ...report, outputDir }));
  if (!search) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(JSON.stringify({ status: "failed", errorCode: error instanceof Error ? error.message : "unknown" }));
  process.exitCode = 1;
});
