import { realpath, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { ResultSetHeader } from "mysql2/promise";
import { z } from "zod";
import type { Comment, Post } from "../xhs-probe/types.js";
import { createDatabaseContext } from "./pool.js";
import {
  CollectionPersistenceService,
  type PersistenceErrorType,
  type PersistPostInput
} from "./persistence/index.js";

const PROBE_ARTIFACT_ROOT = path.resolve("artifacts", "xhs-probe");

const NullableText = z.string().nullable();
const NullableCount = z.number().int().nonnegative().nullable();
export function isAllowedXiaohongshuUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && (url.hostname === "xiaohongshu.com" || url.hostname.endsWith(".xiaohongshu.com"));
  } catch {
    return false;
  }
}

const XiaohongshuUrl = z.string().refine(isAllowedXiaohongshuUrl);
const AuthorSchema = z.object({ nickname: NullableText });
const SourceTimeSchema = z.object({
  value: z.union([z.string(), z.number()]).nullable(),
  source: z.enum(["page_text", "json_ld", "page_state"])
});
const PostSchema = z.object({
  noteId: z.string().trim().min(1),
  title: NullableText,
  author: AuthorSchema,
  displayedTime: NullableText,
  interactionSummary: NullableText,
  sourceUrl: XiaohongshuUrl,
  relevance: z.union([z.enum(["related", "uncertain"]), z.boolean()]),
  relevanceTerms: z.array(z.string()),
  description: NullableText,
  ipLocation: NullableText,
  time: z.union([z.string(), z.number()]).nullable(),
  lastUpdateTime: z.union([z.string(), z.number()]).nullable(),
  timeSources: z.array(SourceTimeSchema),
  tags: z.array(z.string()).nullable(),
  imageUrls: z.array(z.string().url()).nullable(),
  likedCount: NullableCount,
  collectedCount: NullableCount,
  commentCount: NullableCount,
  shareCount: NullableCount
});
const CommentSchema = z.object({
  commentId: z.string().trim().min(1),
  noteId: z.string().trim().min(1),
  parentCommentId: NullableText,
  content: NullableText,
  author: AuthorSchema,
  publishedText: NullableText,
  ipLocation: NullableText,
  likedCount: NullableCount,
  sourceUrl: XiaohongshuUrl
});
const ReportSchema = z.object({
  runId: z.string().trim().min(1),
  keyword: z.string(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  status: z.enum(["success", "partial_success", "auth_required", "blocked", "failed"]),
  limits: z.object({
    searchResults: z.number().int().nonnegative(),
    details: z.number().int().nonnegative(),
    detailDelayMs: z.number().int().nonnegative()
  }),
  counts: z.object({
    rawSearchResults: z.number().int().nonnegative(),
    relatedSearchResults: z.number().int().nonnegative(),
    postsBeforeDeduplication: z.number().int().nonnegative(),
    postsAfterDeduplication: z.number().int().nonnegative(),
    commentsBeforeDeduplication: z.number().int().nonnegative(),
    commentsAfterDeduplication: z.number().int().nonnegative()
  }),
  fieldCoverage: z.record(z.string(), z.object({
    present: z.number().int().nonnegative(),
    total: z.number().int().nonnegative()
  })),
  flags: z.array(z.string()),
  errors: z.array(z.object({
    stage: z.enum(["auth", "search", "detail", "comments", "output"]),
    type: z.enum([
      "auth_required", "page_timeout", "access_blocked", "captcha_required",
      "field_missing", "structure_changed", "unexpected_error"
    ]),
    summary: z.string(),
    noteId: z.string().optional(),
    missingFields: z.array(z.string()).optional()
  }))
});

type ParsedPost = z.infer<typeof PostSchema>;
type ParsedComment = z.infer<typeof CommentSchema>;
type ParsedReport = z.infer<typeof ReportSchema>;

export type ProbeImportErrorCode =
  | "arguments_invalid"
  | "run_directory_invalid"
  | "artifact_read_failed"
  | "artifact_invalid"
  | "database_setup_failed"
  | "persistence_failed";

export class ProbeImportError extends Error {
  constructor(readonly code: ProbeImportErrorCode) {
    super(code);
    this.name = "ProbeImportError";
  }
}

export interface ProbeImportOptions {
  runDir: string;
  brand: string;
}

export interface ProbeImportSummary {
  taskId: number;
  selectedPostCount: number;
  selectedCommentCount: number;
  succeededPostCount: number;
  failedPostCount: number;
  failureCount: number;
  failuresByType: Partial<Record<PersistenceErrorType, number>>;
}

export function selectImportablePosts<
  T extends { noteId: string; relevance: boolean | "related" | "uncertain"; description: string | null },
  C
>(posts: T[], commentsByPost: Map<string, C[]>): T[] {
  return posts.filter((post) =>
    (post.relevance === true || post.relevance === "related")
    && Boolean(post.description?.trim())
    && (commentsByPost.get(post.noteId)?.length ?? 0) > 0
  );
}

function optionValue(args: string[], index: number, name: string): string | undefined {
  const current = args[index];
  if (current?.startsWith(`${name}=`)) return current.slice(name.length + 1);
  if (current === name) {
    const next = args[index + 1];
    return next && !next.startsWith("--") ? next : undefined;
  }
  return undefined;
}

export function parseProbeImportOptions(args: string[]): ProbeImportOptions {
  let runDir: string | undefined;
  let brand: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const runDirValue = optionValue(args, index, "--run-dir");
    if (runDirValue !== undefined) runDir = runDirValue.trim();
    const brandValue = optionValue(args, index, "--brand");
    if (brandValue !== undefined) brand = brandValue.trim();
  }
  if (!runDir || !brand || brand.length > 191) throw new ProbeImportError("arguments_invalid");
  return { runDir, brand };
}

function isWithinArtifactRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export async function resolveProbeRunDirectory(runDir: string): Promise<string> {
  try {
    const artifactRoot = await realpath(PROBE_ARTIFACT_ROOT);
    const requested = path.isAbsolute(runDir) ? path.resolve(runDir) : path.resolve(runDir);
    const resolved = await realpath(requested);
    if (!isWithinArtifactRoot(artifactRoot, resolved) || !(await stat(resolved)).isDirectory()) {
      throw new ProbeImportError("run_directory_invalid");
    }
    return resolved;
  } catch (error) {
    if (error instanceof ProbeImportError) throw error;
    throw new ProbeImportError("run_directory_invalid");
  }
}

async function resolveArtifactFile(runDirectory: string, fileName: string): Promise<string> {
  try {
    const filePath = await realpath(path.join(runDirectory, fileName));
    if (!isWithinArtifactRoot(runDirectory, filePath) || !(await stat(filePath)).isFile()) {
      throw new ProbeImportError("artifact_read_failed");
    }
    return filePath;
  } catch {
    throw new ProbeImportError("artifact_read_failed");
  }
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch {
    throw new ProbeImportError("artifact_read_failed");
  }
}

export async function loadProbeArtifacts(runDirectory: string): Promise<{
  posts: ParsedPost[];
  comments: ParsedComment[];
  report: ParsedReport;
}> {
  let resolvedRunDirectory: string;
  try {
    resolvedRunDirectory = await realpath(runDirectory);
    if (!(await stat(resolvedRunDirectory)).isDirectory()) throw new ProbeImportError("artifact_read_failed");
  } catch {
    throw new ProbeImportError("artifact_read_failed");
  }
  const [postsPath, commentsPath, reportPath] = await Promise.all([
    resolveArtifactFile(resolvedRunDirectory, "posts.json"),
    resolveArtifactFile(resolvedRunDirectory, "comments.json"),
    resolveArtifactFile(resolvedRunDirectory, "report.json")
  ]);
  const [postValue, commentValue, reportValue] = await Promise.all([
    readJsonFile(postsPath),
    readJsonFile(commentsPath),
    readJsonFile(reportPath)
  ]);
  const posts = z.array(PostSchema).safeParse(postValue);
  const comments = z.array(CommentSchema).safeParse(commentValue);
  const report = ReportSchema.safeParse(reportValue);
  if (!posts.success || !comments.success || !report.success) throw new ProbeImportError("artifact_invalid");

  const postIds = new Set(posts.data.map((post) => post.noteId));
  const uniquePostIds = postIds.size === posts.data.length;
  const uniqueCommentIds = new Set(comments.data.map((comment) => comment.commentId)).size === comments.data.length;
  const commentsHaveOwners = comments.data.every((comment) => postIds.has(comment.noteId));
  const runIdMatchesDirectory = report.data.runId === path.basename(resolvedRunDirectory);
  const countsMatch = report.data.counts.postsAfterDeduplication === posts.data.length
    && report.data.counts.commentsAfterDeduplication === comments.data.length;
  if (!uniquePostIds || !uniqueCommentIds || !commentsHaveOwners || !runIdMatchesDirectory || !countsMatch) {
    throw new ProbeImportError("artifact_invalid");
  }
  return { posts: posts.data, comments: comments.data, report: report.data };
}

function toPost(post: ParsedPost): Post {
  return {
    ...post,
    relevance: post.relevance === true || post.relevance === "related" ? "related" : "uncertain"
  };
}

function toComment(comment: ParsedComment): Comment {
  return comment;
}

async function ensureImportConfiguration(
  pool: Awaited<ReturnType<typeof createDatabaseContext>>["pool"],
  brandName: string
): Promise<{ dataSourceId: number; brandId: number; searchTermId: number }> {
  try {
    const [sourceResult] = await pool.execute<ResultSetHeader>(
      `INSERT INTO data_sources (source_code, display_name, source_type, status)
       VALUES ('xiaohongshu', '小红书', 'social_content', 'enabled')
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), status = 'enabled'`
    );
    const dataSourceId = sourceResult.insertId;
    const [brandResult] = await pool.execute<ResultSetHeader>(
      `INSERT INTO brands (data_source_id, brand_name, status, archived_at)
       VALUES (?, ?, 'enabled', NULL)
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), status = 'enabled', archived_at = NULL`,
      [dataSourceId, brandName]
    );
    const brandId = brandResult.insertId;
    const [termResult] = await pool.execute<ResultSetHeader>(
      `INSERT INTO brand_search_terms (brand_id, term_type, term_value, status, archived_at)
       VALUES (?, 'alias', ?, 'enabled', NULL)
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), status = 'enabled', archived_at = NULL`,
      [brandId, brandName]
    );
    return { dataSourceId, brandId, searchTermId: termResult.insertId };
  } catch {
    throw new ProbeImportError("database_setup_failed");
  }
}

export async function importProbeRun(options: ProbeImportOptions): Promise<ProbeImportSummary> {
  const runDirectory = await resolveProbeRunDirectory(options.runDir);
  const artifacts = await loadProbeArtifacts(runDirectory);
  const observedAt = new Date(artifacts.report.finishedAt);
  const commentsByPost = new Map<string, ParsedComment[]>();
  for (const comment of artifacts.comments) {
    const ownerComments = commentsByPost.get(comment.noteId) ?? [];
    ownerComments.push(comment);
    commentsByPost.set(comment.noteId, ownerComments);
  }
  const selectedPosts = selectImportablePosts(artifacts.posts, commentsByPost);

  let context: Awaited<ReturnType<typeof createDatabaseContext>> | undefined;
  try {
    context = await createDatabaseContext();
    const configuration = await ensureImportConfiguration(context.pool, options.brand);
    const service = new CollectionPersistenceService(context.pool);
    const taskId = await service.tasks.createTask({
      dataSourceId: configuration.dataSourceId,
      brandId: configuration.brandId,
      triggerType: "manual"
    });
    const items: PersistPostInput[] = selectedPosts.map((post) => ({
      post: toPost(post),
      comments: (commentsByPost.get(post.noteId) ?? []).map((comment) => ({
        ...toComment(comment),
        rawPayload: comment
      })),
      matches: [{ searchTermId: configuration.searchTermId, matchedTermSnapshot: options.brand }],
      observedAt,
      rawPayload: post
    }));
    const selectedCommentCount = items.reduce((total, item) => total + item.comments.length, 0);
    const result = await service.persistBatch({
      taskId,
      dataSourceId: configuration.dataSourceId,
      brandId: configuration.brandId,
      items
    });
    const failuresByType: Partial<Record<PersistenceErrorType, number>> = {};
    for (const failure of result.failures) {
      failuresByType[failure.errorType] = (failuresByType[failure.errorType] ?? 0) + 1;
    }
    return {
      taskId,
      selectedPostCount: items.length,
      selectedCommentCount,
      succeededPostCount: result.succeededPostCount,
      failedPostCount: result.failedPostCount,
      failureCount: result.failures.length,
      failuresByType
    };
  } catch (error) {
    if (error instanceof ProbeImportError) throw error;
    throw new ProbeImportError("persistence_failed");
  } finally {
    await context?.pool.end().catch(() => undefined);
  }
}

export function safeProbeImportErrorCode(error: unknown): ProbeImportErrorCode {
  return error instanceof ProbeImportError ? error.code : "persistence_failed";
}

async function main(): Promise<void> {
  try {
    const options = parseProbeImportOptions(process.argv.slice(2));
    const summary = await importProbeRun(options);
    console.log(JSON.stringify({ ok: summary.failedPostCount === 0, ...summary }));
    if (summary.failedPostCount > 0) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, errorCode: safeProbeImportErrorCode(error) }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
