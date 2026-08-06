import { randomUUID } from "node:crypto";
import process from "node:process";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { Comment, Post } from "../xhs-probe/types.js";
import { advanceCollectionCursor, acquireBrandLease, releaseBrandLease, renewBrandLease } from "./coordination/index.js";
import { createDatabaseContext } from "./pool.js";
import {
  CollectionPersistenceRepository,
  CollectionPersistenceService,
  CollectionTaskRepository,
  type PersistPostInput
} from "./persistence/index.js";

const TEST_PREFIX = "__readtrace_ac_";

interface IntegrationResults {
  ac4: boolean;
  ac5: boolean;
  ac6: boolean;
  ac7: boolean;
  ac8: boolean;
  ac9: boolean;
  ac10: boolean;
  ac11: boolean;
  ac12: boolean;
  cleanup: boolean;
}

interface TestState {
  dataSourceId: number | null;
  brandId: number | null;
  searchTermIds: number[];
  taskIds: number[];
  retryTaskIds: number[];
  postIds: number[];
  platformPostIds: string[];
}

interface IdRow extends RowDataPacket {
  id: number;
}

interface PostVerificationRow extends RowDataPacket {
  id: number;
  title: string | null;
  description: string | null;
  firstCollectedAt: Date;
  lastCollectedAt: Date;
}

interface CountRow extends RowDataPacket {
  rowCount: number;
  nullCount?: number;
}

interface CommentVerificationRow extends RowDataPacket {
  id: number;
  platformCommentId: string;
  parentCommentId: number | null;
}

interface RawPayloadRow extends RowDataPacket {
  payload: unknown;
}

interface TaskVerificationRow extends RowDataPacket {
  status: string;
  succeededPostCount: number;
  failedPostCount: number;
  retryOfTaskId: number | null;
}

interface CursorVerificationRow extends RowDataPacket {
  cursorVersion: number;
  lastSuccessfulTaskId: number;
}

function postFixture(runKey: string, noteId: string, overrides: Partial<Post> = {}): Post {
  return {
    noteId,
    title: `${TEST_PREFIX}${runKey}_title`,
    author: { nickname: `${TEST_PREFIX}${runKey}_author` },
    displayedTime: "2026-08-06",
    interactionSummary: null,
    sourceUrl: `https://www.xiaohongshu.com/explore/${noteId}`,
    relevance: "related",
    relevanceTerms: ["Leader"],
    description: `${TEST_PREFIX}${runKey}_description`,
    ipLocation: "浙江",
    time: "2026-08-06T01:02:03.456Z",
    lastUpdateTime: "2026-08-06T01:03:04.567Z",
    timeSources: [],
    tags: ["冰箱"],
    imageUrls: ["https://img.example.test/integration.jpg"],
    likedCount: 10,
    collectedCount: 3,
    commentCount: 2,
    shareCount: 1,
    ...overrides
  };
}

function commentFixture(noteId: string, commentId: string, parentCommentId: string | null): Comment {
  return {
    commentId,
    noteId,
    parentCommentId,
    content: `${TEST_PREFIX}comment_content`,
    author: { nickname: `${TEST_PREFIX}comment_author` },
    publishedText: "昨天",
    ipLocation: "江苏",
    likedCount: 2,
    sourceUrl: `https://www.xiaohongshu.com/explore/${noteId}?comment=${commentId}`
  };
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isSafeInteger(value) && value > 0))];
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

async function createTrackedTask(
  tasks: CollectionTaskRepository,
  state: TestState,
  dataSourceId: number,
  brandId: number,
  triggerType: "manual" | "scheduled"
): Promise<number> {
  const taskId = await tasks.createTask({ dataSourceId, brandId, triggerType });
  state.taskIds.push(taskId);
  return taskId;
}

async function persistWithRepository(
  pool: Pool,
  repository: CollectionPersistenceRepository,
  dataSourceId: number,
  brandId: number,
  taskId: number,
  item: PersistPostInput,
  repeatWithinTask: boolean
): Promise<{ postId: number; commentIds: Map<string, number> }> {
  const connection = await pool.getConnection();
  let reusable = true;
  try {
    await connection.beginTransaction();
    const postId = await repository.upsertPost(connection, dataSourceId, taskId, item);
    let commentIds = await repository.upsertComments(connection, dataSourceId, taskId, postId, item);
    await repository.appendInteractionSnapshots(connection, taskId, postId, commentIds, item);
    await repository.saveRawSnapshots(connection, taskId, postId, commentIds, item);
    await repository.saveBrandMatches(connection, dataSourceId, brandId, taskId, postId, item.matches);
    if (repeatWithinTask) {
      commentIds = await repository.upsertComments(connection, dataSourceId, taskId, postId, item);
      await repository.appendInteractionSnapshots(connection, taskId, postId, commentIds, item);
      await repository.saveBrandMatches(connection, dataSourceId, brandId, taskId, postId, item.matches);
    }
    await connection.commit();
    return { postId, commentIds };
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      reusable = false;
      connection.destroy();
    }
    throw error;
  } finally {
    if (reusable) connection.release();
  }
}

async function loadPostIds(pool: Pool, state: TestState): Promise<void> {
  if (state.dataSourceId === null || state.platformPostIds.length === 0) return;
  const externalIds = [...new Set(state.platformPostIds)];
  const [rows] = await pool.execute<IdRow[]>(
    `SELECT id FROM posts
     WHERE data_source_id = ? AND platform_post_id IN (${placeholders(externalIds.length)})`,
    [state.dataSourceId, ...externalIds]
  );
  state.postIds = uniqueNumbers([...state.postIds, ...rows.map((row) => row.id)]);
}

async function deleteIds(pool: Pool, table: string, ids: number[]): Promise<void> {
  const uniqueIds = uniqueNumbers(ids);
  if (uniqueIds.length === 0) return;
  await pool.execute(`DELETE FROM ${table} WHERE id IN (${placeholders(uniqueIds.length)})`, uniqueIds);
}

async function cleanupIntegrationData(pool: Pool, state: TestState): Promise<void> {
  await loadPostIds(pool, state);
  const postIds = uniqueNumbers(state.postIds);
  const taskIds = uniqueNumbers(state.taskIds);
  const retryTaskIds = uniqueNumbers(state.retryTaskIds);
  const ordinaryTaskIds = taskIds.filter((id) => !retryTaskIds.includes(id));

  if (state.brandId !== null && state.dataSourceId !== null) {
    await pool.execute(
      "DELETE FROM collection_locks WHERE data_source_id = ? AND brand_id = ?",
      [state.dataSourceId, state.brandId]
    );
    await pool.execute(
      "DELETE FROM collection_cursors WHERE data_source_id = ? AND brand_id = ?",
      [state.dataSourceId, state.brandId]
    );
    await pool.execute("DELETE FROM brand_post_matches WHERE brand_id = ?", [state.brandId]);
  }
  if (taskIds.length > 0) {
    await pool.execute(
      `DELETE FROM raw_field_snapshots WHERE task_id IN (${placeholders(taskIds.length)})`,
      taskIds
    );
    await pool.execute(
      `DELETE FROM comment_interaction_snapshots WHERE task_id IN (${placeholders(taskIds.length)})`,
      taskIds
    );
    await pool.execute(
      `DELETE FROM post_interaction_snapshots WHERE task_id IN (${placeholders(taskIds.length)})`,
      taskIds
    );
  }
  if (postIds.length > 0) {
    await pool.execute(
      `DELETE FROM comments WHERE post_id IN (${placeholders(postIds.length)}) AND parent_comment_id IS NOT NULL`,
      postIds
    );
    await pool.execute(
      `DELETE FROM comments WHERE post_id IN (${placeholders(postIds.length)})`,
      postIds
    );
    await deleteIds(pool, "posts", postIds);
  }
  await deleteIds(pool, "collection_tasks", retryTaskIds);
  await deleteIds(pool, "collection_tasks", ordinaryTaskIds);
  await deleteIds(pool, "brand_search_terms", state.searchTermIds);
  if (state.brandId !== null) await deleteIds(pool, "brands", [state.brandId]);
}

async function main(): Promise<void> {
  const results: IntegrationResults = {
    ac4: false,
    ac5: false,
    ac6: false,
    ac7: false,
    ac8: false,
    ac9: false,
    ac10: false,
    ac11: false,
    ac12: false,
    cleanup: false
  };
  const state: TestState = {
    dataSourceId: null,
    brandId: null,
    searchTermIds: [],
    taskIds: [],
    retryTaskIds: [],
    postIds: [],
    platformPostIds: []
  };
  let context: Awaited<ReturnType<typeof createDatabaseContext>> | undefined;
  let stage = "connect";
  let failureStage: string | null = null;
  let executionFailed = false;
  const runKey = randomUUID().replaceAll("-", "");

  try {
    context = await createDatabaseContext();
    const { pool } = context;
    const tasks = new CollectionTaskRepository(pool);
    const repository = new CollectionPersistenceRepository();

    stage = "setup";
    const [sourceRows] = await pool.execute<Array<IdRow & { sourceCode: string }>>(
      "SELECT id, source_code AS sourceCode FROM data_sources WHERE source_code = ? AND status = 'enabled'",
      ["xiaohongshu"]
    );
    const source = sourceRows[0];
    if (!source) throw new Error("integration_setup_failed");
    state.dataSourceId = source.id;

    const brandName = `${TEST_PREFIX}${runKey}`;
    const [brandResult] = await pool.execute<ResultSetHeader>(
      "INSERT INTO brands (data_source_id, brand_name, status) VALUES (?, ?, 'enabled')",
      [source.id, brandName]
    );
    state.brandId = brandResult.insertId;
    const termValues = [`${TEST_PREFIX}${runKey}_alias`, `${TEST_PREFIX}${runKey}_model`];
    for (const [index, termValue] of termValues.entries()) {
      const [termResult] = await pool.execute<ResultSetHeader>(
        "INSERT INTO brand_search_terms (brand_id, term_type, term_value, status) VALUES (?, ?, ?, 'enabled')",
        [state.brandId, index === 0 ? "alias" : "model", termValue]
      );
      state.searchTermIds.push(termResult.insertId);
    }
    const aliasTermId = state.searchTermIds[0];
    const modelTermId = state.searchTermIds[1];
    if (!aliasTermId || !modelTermId) throw new Error("integration_setup_failed");

    stage = "ac4_ac8";
    const mainNoteId = `${TEST_PREFIX}${runKey}_post_main`;
    const parentCommentId = `${TEST_PREFIX}${runKey}_comment_parent`;
    const childCommentId = `${TEST_PREFIX}${runKey}_comment_child`;
    state.platformPostIds.push(mainNoteId);
    const firstObservedAt = new Date("2026-08-06T01:00:00.111Z");
    const secondObservedAt = new Date("2026-08-06T02:00:00.222Z");
    const firstTaskId = await createTrackedTask(tasks, state, source.id, state.brandId, "manual");
    await tasks.startTask(firstTaskId, source.id, state.brandId);
    const firstItem: PersistPostInput = {
      post: postFixture(runKey, mainNoteId),
      comments: [
        commentFixture(mainNoteId, childCommentId, parentCommentId),
        commentFixture(mainNoteId, parentCommentId, null)
      ],
      matches: [
        { searchTermId: aliasTermId, matchedTermSnapshot: termValues[0] ?? "" },
        { searchTermId: modelTermId, matchedTermSnapshot: termValues[1] ?? "" },
        { searchTermId: aliasTermId, matchedTermSnapshot: termValues[0] ?? "" }
      ],
      observedAt: firstObservedAt,
      rawPayload: {
        noteId: mainNoteId,
        nested: {
          a1: `${TEST_PREFIX}secret_a1`,
          "x-s": `${TEST_PREFIX}secret_xs`,
          cookie: `${TEST_PREFIX}secret_cookie`,
          authorization: `${TEST_PREFIX}secret_authorization`
        }
      }
    };
    const firstPersisted = await persistWithRepository(
      pool,
      repository,
      source.id,
      state.brandId,
      firstTaskId,
      firstItem,
      true
    );
    state.postIds.push(firstPersisted.postId);
    await tasks.finishTask(firstTaskId, "success", 1, 0, null, null);

    const secondTaskId = await createTrackedTask(tasks, state, source.id, state.brandId, "scheduled");
    await tasks.startTask(secondTaskId, source.id, state.brandId);
    const secondItem: PersistPostInput = {
      post: postFixture(runKey, mainNoteId, {
        title: `${TEST_PREFIX}${runKey}_updated_title`,
        description: null,
        author: { nickname: null },
        ipLocation: null,
        tags: null,
        imageUrls: null,
        likedCount: null,
        collectedCount: null,
        commentCount: null,
        shareCount: null
      }),
      comments: [
        commentFixture(mainNoteId, parentCommentId, null),
        commentFixture(mainNoteId, childCommentId, parentCommentId)
      ],
      matches: [],
      observedAt: secondObservedAt
    };
    const secondPersisted = await persistWithRepository(
      pool,
      repository,
      source.id,
      state.brandId,
      secondTaskId,
      secondItem,
      false
    );
    state.postIds.push(secondPersisted.postId);
    await tasks.finishTask(secondTaskId, "success", 1, 0, null, null);

    const [postRows] = await pool.execute<PostVerificationRow[]>(
      `SELECT id, title, description,
              first_collected_at AS firstCollectedAt, last_collected_at AS lastCollectedAt
       FROM posts WHERE data_source_id = ? AND platform_post_id = ?`,
      [source.id, mainNoteId]
    );
    const postRow = postRows[0];
    results.ac4 = postRows.length === 1
      && postRow?.title === `${TEST_PREFIX}${runKey}_updated_title`
      && postRow.description === `${TEST_PREFIX}${runKey}_description`
      && postRow.firstCollectedAt.getTime() === firstObservedAt.getTime()
      && postRow.lastCollectedAt.getTime() === secondObservedAt.getTime();

    const [commentRows] = await pool.execute<CommentVerificationRow[]>(
      `SELECT id, platform_comment_id AS platformCommentId, parent_comment_id AS parentCommentId
       FROM comments WHERE post_id = ? ORDER BY platform_comment_id`,
      [firstPersisted.postId]
    );
    const parent = commentRows.find((row) => row.platformCommentId === parentCommentId);
    const child = commentRows.find((row) => row.platformCommentId === childCommentId);
    results.ac5 = commentRows.length === 2
      && parent?.parentCommentId === null
      && child?.parentCommentId === parent?.id;

    const [postSnapshotRows] = await pool.execute<CountRow[]>(
      `SELECT COUNT(*) AS rowCount,
              SUM(CASE WHEN liked_count IS NULL AND collected_count IS NULL
                        AND comment_count IS NULL AND share_count IS NULL THEN 1 ELSE 0 END) AS nullCount
       FROM post_interaction_snapshots WHERE post_id = ?`,
      [firstPersisted.postId]
    );
    const [commentSnapshotRows] = await pool.execute<CountRow[]>(
      `SELECT COUNT(*) AS rowCount FROM comment_interaction_snapshots
       WHERE comment_id IN (${placeholders(firstPersisted.commentIds.size)})`,
      [...firstPersisted.commentIds.values()]
    );
    results.ac6 = Number(postSnapshotRows[0]?.rowCount) === 2
      && Number(postSnapshotRows[0]?.nullCount) === 1
      && Number(commentSnapshotRows[0]?.rowCount) === 4;

    const [matchRows] = await pool.execute<CountRow[]>(
      "SELECT COUNT(*) AS rowCount FROM brand_post_matches WHERE brand_id = ? AND post_id = ?",
      [state.brandId, firstPersisted.postId]
    );
    results.ac7 = Number(matchRows[0]?.rowCount) === 2;

    const [rawRows] = await pool.execute<RawPayloadRow[]>(
      "SELECT payload FROM raw_field_snapshots WHERE task_id = ? AND post_id = ? AND snapshot_kind = 'post'",
      [firstTaskId, firstPersisted.postId]
    );
    const rawText = typeof rawRows[0]?.payload === "string"
      ? rawRows[0].payload
      : JSON.stringify(rawRows[0]?.payload ?? null);
    results.ac8 = rawRows.length === 1
      && rawText.includes(mainNoteId)
      && !rawText.includes(`${TEST_PREFIX}secret_a1`)
      && !rawText.includes(`${TEST_PREFIX}secret_xs`)
      && !rawText.includes(`${TEST_PREFIX}secret_cookie`)
      && !rawText.includes(`${TEST_PREFIX}secret_authorization`);

    stage = "ac9";
    const partialTaskId = await createTrackedTask(tasks, state, source.id, state.brandId, "manual");
    const partialSuccessNoteId = `${TEST_PREFIX}${runKey}_post_partial_ok`;
    const partialFailedNoteId = `${TEST_PREFIX}${runKey}_post_partial_failed`;
    state.platformPostIds.push(partialSuccessNoteId, partialFailedNoteId);
    const service = new CollectionPersistenceService(pool);
    const partialResult = await service.persistBatch({
      taskId: partialTaskId,
      dataSourceId: source.id,
      brandId: state.brandId,
      items: [
        {
          post: postFixture(runKey, partialSuccessNoteId),
          comments: [],
          matches: [],
          observedAt: new Date("2026-08-06T03:00:00.333Z")
        },
        {
          post: postFixture(runKey, partialFailedNoteId),
          comments: [],
          matches: [],
          observedAt: new Date("2026-08-06T03:01:00.444Z"),
          rawPayload: { unsupported: 1n }
        }
      ]
    });
    const [partialPostRows] = await pool.execute<Array<IdRow & { platformPostId: string }>>(
      `SELECT id, platform_post_id AS platformPostId FROM posts
       WHERE data_source_id = ? AND platform_post_id IN (?, ?)`,
      [source.id, partialSuccessNoteId, partialFailedNoteId]
    );
    state.postIds.push(...partialPostRows.map((row) => row.id));
    const [partialTaskRows] = await pool.execute<TaskVerificationRow[]>(
      `SELECT status, succeeded_post_count AS succeededPostCount,
              failed_post_count AS failedPostCount, retry_of_task_id AS retryOfTaskId
       FROM collection_tasks WHERE id = ?`,
      [partialTaskId]
    );
    results.ac9 = partialResult.status === "partial_success"
      && partialResult.succeededPostCount === 1
      && partialResult.failedPostCount === 1
      && partialTaskRows[0]?.status === "partial_success"
      && partialTaskRows[0].succeededPostCount === 1
      && partialTaskRows[0].failedPostCount === 1
      && partialPostRows.length === 1
      && partialPostRows[0]?.platformPostId === partialSuccessNoteId;

    stage = "ac10";
    const failedTaskId = await createTrackedTask(tasks, state, source.id, state.brandId, "scheduled");
    await tasks.failBeforeData(failedTaskId, "database_write_failed");
    const retryTaskId = await tasks.createRetryTask(failedTaskId);
    state.taskIds.push(retryTaskId);
    state.retryTaskIds.push(retryTaskId);
    const [failedTaskRows] = await pool.execute<TaskVerificationRow[]>(
      `SELECT status, succeeded_post_count AS succeededPostCount,
              failed_post_count AS failedPostCount, retry_of_task_id AS retryOfTaskId
       FROM collection_tasks WHERE id IN (?, ?) ORDER BY id`,
      [failedTaskId, retryTaskId]
    );
    const failedTask = failedTaskRows.find((row) => row.status === "failed");
    const retryTask = failedTaskRows.find((row) => row.retryOfTaskId === failedTaskId);
    const [failedCursorRows] = await pool.execute<CountRow[]>(
      "SELECT COUNT(*) AS rowCount FROM collection_cursors WHERE last_successful_task_id = ?",
      [failedTaskId]
    );
    results.ac10 = failedTask?.succeededPostCount === 0
      && failedTask.failedPostCount === 0
      && retryTask?.status === "queued"
      && Number(failedCursorRows[0]?.rowCount) === 0;

    stage = "ac11";
    const lockTaskOne = await createTrackedTask(tasks, state, source.id, state.brandId, "manual");
    const lockTaskTwo = await createTrackedTask(tasks, state, source.id, state.brandId, "scheduled");
    const firstOwnerToken = randomUUID();
    const secondOwnerToken = randomUUID();
    const firstLease = await acquireBrandLease(pool, {
      dataSourceId: source.id,
      brandId: state.brandId,
      taskId: lockTaskOne,
      ownerToken: firstOwnerToken,
      leaseDurationMs: 60_000
    });
    const rejectedLease = await acquireBrandLease(pool, {
      dataSourceId: source.id,
      brandId: state.brandId,
      taskId: lockTaskTwo,
      ownerToken: secondOwnerToken,
      leaseDurationMs: 60_000
    });
    await pool.execute(
      `UPDATE collection_locks SET lease_expires_at = TIMESTAMPADD(SECOND, ?, UTC_TIMESTAMP(3))
       WHERE data_source_id = ? AND brand_id = ? AND task_id = ?`,
      [-1, source.id, state.brandId, lockTaskOne]
    );
    const takenOverLease = await acquireBrandLease(pool, {
      dataSourceId: source.id,
      brandId: state.brandId,
      taskId: lockTaskTwo,
      ownerToken: secondOwnerToken,
      leaseDurationMs: 60_000
    });
    const oldRenew = await renewBrandLease(pool, {
      dataSourceId: source.id,
      brandId: state.brandId,
      taskId: lockTaskOne,
      ownerToken: firstOwnerToken,
      leaseDurationMs: 60_000
    });
    const oldRelease = await releaseBrandLease(pool, {
      dataSourceId: source.id,
      brandId: state.brandId,
      taskId: lockTaskOne,
      ownerToken: firstOwnerToken
    });
    const currentRelease = await releaseBrandLease(pool, {
      dataSourceId: source.id,
      brandId: state.brandId,
      taskId: lockTaskTwo,
      ownerToken: secondOwnerToken
    });
    results.ac11 = firstLease.acquired
      && !rejectedLease.acquired
      && rejectedLease.reason === "active_lease"
      && takenOverLease.acquired
      && takenOverLease.outcome === "taken_over"
      && !oldRenew.renewed
      && !oldRelease.released
      && currentRelease.released;

    stage = "ac12";
    const cursorTaskId = await createTrackedTask(tasks, state, source.id, state.brandId, "manual");
    await tasks.startTask(cursorTaskId, source.id, state.brandId);
    const failedStage = await advanceCollectionCursor(pool, {
      dataSourceId: source.id,
      brandId: state.brandId,
      stageCode: "integration",
      scopeKey: runKey,
      cursorValue: { page: 0 },
      taskId: cursorTaskId,
      expectedCursorVersion: 0,
      stageOutcome: "failed"
    });
    const createdCursor = await advanceCollectionCursor(pool, {
      dataSourceId: source.id,
      brandId: state.brandId,
      stageCode: "integration",
      scopeKey: runKey,
      cursorValue: { page: 1 },
      taskId: cursorTaskId,
      expectedCursorVersion: 0,
      stageOutcome: "success"
    });
    const updatedCursor = await advanceCollectionCursor(pool, {
      dataSourceId: source.id,
      brandId: state.brandId,
      stageCode: "integration",
      scopeKey: runKey,
      cursorValue: { page: 2 },
      taskId: cursorTaskId,
      expectedCursorVersion: 1,
      stageOutcome: "success"
    });
    const staleCursor = await advanceCollectionCursor(pool, {
      dataSourceId: source.id,
      brandId: state.brandId,
      stageCode: "integration",
      scopeKey: runKey,
      cursorValue: { page: 3 },
      taskId: cursorTaskId,
      expectedCursorVersion: 1,
      stageOutcome: "success"
    });
    const [cursorRows] = await pool.execute<CursorVerificationRow[]>(
      `SELECT cursor_version AS cursorVersion, last_successful_task_id AS lastSuccessfulTaskId
       FROM collection_cursors
       WHERE data_source_id = ? AND brand_id = ? AND stage_code = ? AND scope_key = ?`,
      [source.id, state.brandId, "integration", runKey]
    );
    results.ac12 = !failedStage.advanced
      && failedStage.reason === "stage_failed"
      && createdCursor.advanced
      && createdCursor.cursorVersion === 1
      && updatedCursor.advanced
      && updatedCursor.cursorVersion === 2
      && !staleCursor.advanced
      && staleCursor.reason === "stale_cursor"
      && cursorRows[0]?.cursorVersion === 2
      && cursorRows[0].lastSuccessfulTaskId === cursorTaskId;

    if (!Object.entries(results).filter(([key]) => key !== "cleanup").every(([, value]) => value)) {
      stage = "verification";
      failureStage = stage;
      executionFailed = true;
    }
  } catch {
    failureStage = stage;
    executionFailed = true;
  } finally {
    if (context) {
      try {
        await cleanupIntegrationData(context.pool, state);
        results.cleanup = true;
      } catch {
        failureStage = "cleanup";
        executionFailed = true;
        results.cleanup = false;
      }
      try {
        await context.pool.end();
      } catch {
        failureStage = "cleanup";
        executionFailed = true;
        results.cleanup = false;
      }
    }
  }

  const acPassed = Object.entries(results).filter(([key]) => key !== "cleanup").every(([, value]) => value);
  const ok = !executionFailed && acPassed && results.cleanup;
  console.log(JSON.stringify({ ok, ...results, ...(ok ? {} : { stage: failureStage ?? stage }) }));
  if (!ok) process.exitCode = 1;
}

void main();
