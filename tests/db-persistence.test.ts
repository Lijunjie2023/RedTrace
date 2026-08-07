import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolConnection } from "mysql2/promise";
import type { Comment, Post } from "../src/xhs-probe/types.js";
import {
  CollectionPersistenceRepository,
  CollectionPersistenceService,
  CollectionTaskRepository,
  PersistenceError,
  mapProbeComment,
  mapProbePost,
  parsePlatformDate,
  serializeSanitizedPayload,
  type PersistPostInput
} from "../src/db/persistence/index.js";

test("平台发布时间支持秒级、毫秒级时间戳和标准日期", () => {
  assert.equal(parsePlatformDate("1722470400")?.toISOString(), "2024-08-01T00:00:00.000Z");
  assert.equal(parsePlatformDate("1722470400000")?.toISOString(), "2024-08-01T00:00:00.000Z");
  assert.equal(parsePlatformDate("2024-08-01T08:00:00+08:00")?.toISOString(), "2024-08-01T00:00:00.000Z");
  assert.equal(parsePlatformDate("17224704000"), null);
  assert.equal(parsePlatformDate("昨天"), null);
  assert.equal(parsePlatformDate(null), null);
});

interface SqlCall {
  sql: string;
  params: unknown[];
}

function postFixture(overrides: Partial<Post> = {}): Post {
  return {
    noteId: "note-1",
    title: "Leader冰箱",
    author: { nickname: "用户甲" },
    displayedTime: "2026-08-06",
    interactionSummary: null,
    sourceUrl: "https://www.xiaohongshu.com/explore/note-1",
    relevance: "related",
    relevanceTerms: ["Leader"],
    description: "正文",
    ipLocation: "浙江",
    time: "2026-08-06T01:02:03.456Z",
    lastUpdateTime: 1_786_000_000_000,
    timeSources: [],
    tags: ["冰箱"],
    imageUrls: ["https://img.example.test/1.jpg"],
    likedCount: 12,
    collectedCount: 3,
    commentCount: 2,
    shareCount: 1,
    ...overrides
  };
}

function commentFixture(overrides: Partial<Comment> = {}): Comment {
  return {
    commentId: "comment-1",
    noteId: "note-1",
    parentCommentId: null,
    content: "评论",
    author: { nickname: "用户乙" },
    publishedText: "昨天",
    ipLocation: "江苏",
    likedCount: 4,
    sourceUrl: "https://www.xiaohongshu.com/explore/note-1?comment=comment-1",
    ...overrides
  };
}

function itemFixture(noteId = "note-1", overrides: Partial<PersistPostInput> = {}): PersistPostInput {
  return {
    post: postFixture({
      noteId,
      sourceUrl: `https://www.xiaohongshu.com/explore/${noteId}`
    }),
    comments: [],
    matches: [],
    observedAt: new Date("2026-08-06T02:03:04.567Z"),
    ...overrides
  };
}

function recordingConnection(
  execute: (sql: string, params: unknown[]) => Promise<unknown> = async () => [{ affectedRows: 1, insertId: 1 }, []]
): { connection: PoolConnection; calls: SqlCall[] } {
  const calls: SqlCall[] = [];
  const connection = {
    execute: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return execute(sql, params);
    }
  } as unknown as PoolConnection;
  return { connection, calls };
}

test("帖子和评论映射保留缺失值并规范化外部ID", () => {
  const post = mapProbePost(postFixture({
    noteId: "  Note-Aa  ",
    sourceUrl: "  https://example.test/Note-Aa  ",
    title: null,
    description: null,
    author: { nickname: null },
    ipLocation: null,
    time: null,
    lastUpdateTime: "invalid-time",
    displayedTime: null,
    tags: null,
    imageUrls: null,
    likedCount: null,
    collectedCount: null,
    commentCount: null,
    shareCount: null
  }));
  const comment = mapProbeComment({
    ...commentFixture({
      commentId: "  Comment-Aa  ",
      parentCommentId: "Parent-Aa",
      content: null,
      author: { nickname: null },
      publishedText: null,
      ipLocation: null,
      likedCount: null
    }),
    targetCommentId: "Target-Aa"
  });

  assert.equal(post.platformPostId, "Note-Aa");
  assert.equal(post.sourceUrl, "https://example.test/Note-Aa");
  assert.equal(post.publishedAt, null);
  assert.equal(post.platformUpdatedAt, null);
  assert.equal(post.title, null);
  assert.equal(post.tags, null);
  assert.equal(post.likedCount, null);
  assert.deepEqual(comment, {
    platformCommentId: "Comment-Aa",
    platformParentCommentId: "Parent-Aa",
    platformTargetCommentId: "Target-Aa",
    content: null,
    authorNickname: null,
    publishedText: null,
    ipLocation: null,
    likedCount: null
  });
});

test("帖子幂等SQL用COALESCE保护旧值并保留首次采集时间", async () => {
  const repository = new CollectionPersistenceRepository();
  const { connection, calls } = recordingConnection(async () => [{ affectedRows: 2, insertId: 41 }, []]);
  const item = itemFixture("Note-Aa", {
    post: postFixture({
      noteId: "Note-Aa",
      title: null,
      description: null,
      author: { nickname: null },
      ipLocation: null,
      time: null,
      lastUpdateTime: null,
      displayedTime: null,
      tags: null,
      imageUrls: null
    })
  });

  const postId = await repository.upsertPost(connection, 3, 7, item);
  assert.equal(postId, 41);
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.sql ?? "", /ON DUPLICATE KEY UPDATE/);
  assert.match(calls[0]?.sql ?? "", /description = COALESCE\(\?, description\)/);
  assert.doesNotMatch(calls[0]?.sql ?? "", /first_collected_at\s*=/);
  assert.deepEqual(calls[0]?.params.slice(0, 15), [
    3,
    "Note-Aa",
    "https://www.xiaohongshu.com/explore/note-1",
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    item.observedAt,
    item.observedAt,
    7
  ]);
});

test("评论先写父级并保留暂缺父评论的平台ID", async () => {
  let nextCommentId = 100;
  const repository = new CollectionPersistenceRepository();
  const { connection, calls } = recordingConnection(async (sql) => {
    if (sql.startsWith("SELECT id FROM comments")) return [[], []];
    if (sql.includes("INSERT INTO comments")) return [{ affectedRows: 1, insertId: ++nextCommentId }, []];
    return [{ affectedRows: 1, insertId: 0 }, []];
  });
  const item = itemFixture("note-1", {
    comments: [
      commentFixture({ commentId: "child", parentCommentId: "parent" }),
      commentFixture({ commentId: "orphan", parentCommentId: "missing-parent" }),
      commentFixture({ commentId: "parent", parentCommentId: null })
    ]
  });

  const ids = await repository.upsertComments(connection, 2, 9, 50, item);
  const inserts = calls.filter((call) => call.sql.includes("INSERT INTO comments"));
  assert.deepEqual([...ids.entries()], [["parent", 101], ["child", 102], ["orphan", 103]]);
  assert.equal(inserts[1]?.params[3], 101);
  assert.equal(inserts[1]?.params[4], "parent");
  assert.equal(inserts[2]?.params[3], null);
  assert.equal(inserts[2]?.params[4], "missing-parent");
  assert.match(inserts[2]?.sql ?? "", /parent_comment_id = COALESCE\(\?, parent_comment_id\)/);
  const parentLookup = calls.find((call) => call.sql.startsWith("SELECT id FROM comments"));
  assert.match(parentLookup?.sql ?? "", /post_id = \?/);
  assert.deepEqual(parentLookup?.params, [2, 50, "missing-parent"]);
  assert.doesNotMatch(inserts[0]?.sql ?? "", /post_id = \?/);
  assert.match(calls.at(-1)?.sql ?? "", /SET child\.parent_comment_id = parent\.id/);
});

test("重复评论属于其他帖子时拒绝跨帖覆盖", async () => {
  const repository = new CollectionPersistenceRepository();
  const { connection, calls } = recordingConnection(async (sql) => {
    if (sql.includes("INSERT INTO comments")) return [{ affectedRows: 2, insertId: 101 }, []];
    if (sql.includes("SELECT post_id AS postId")) return [[{ postId: 999 }], []];
    return [{ affectedRows: 1, insertId: 0 }, []];
  });
  const item = itemFixture("note-1", { comments: [commentFixture()] });

  await assert.rejects(
    () => repository.upsertComments(connection, 2, 9, 50, item),
    (error: unknown) => error instanceof PersistenceError
      && error.errorType === "input_invalid"
      && error.message === "comment_post_mismatch"
  );
  const insert = calls.find((call) => call.sql.includes("INSERT INTO comments"));
  assert.doesNotMatch(insert?.sql ?? "", /post_id = \?/);
  assert.deepEqual(calls.find((call) => call.sql.includes("FOR UPDATE"))?.params, [101]);
  assert.equal(calls.some((call) => call.sql.includes("UPDATE comments AS child")), false);
});

test("互动快照和品牌命中使用幂等SQL并保留null参数", async () => {
  const repository = new CollectionPersistenceRepository();
  const { connection, calls } = recordingConnection();
  const observedAt = new Date("2026-08-06T03:04:05.678Z");
  const item = itemFixture("note-1", {
    observedAt,
    post: postFixture({ likedCount: null, collectedCount: null, commentCount: null, shareCount: null }),
    comments: [commentFixture({ likedCount: null })]
  });

  await repository.appendInteractionSnapshots(connection, 9, 50, new Map([["comment-1", 60]]), item);
  await repository.saveBrandMatches(connection, 2, 3, 9, 50, [
    { searchTermId: 5, matchedTermSnapshot: "旧值" },
    { searchTermId: 6, matchedTermSnapshot: "型号词" },
    { searchTermId: 5, matchedTermSnapshot: "Leader" }
  ]);

  const postSnapshot = calls.find((call) => call.sql.includes("post_interaction_snapshots"));
  const commentSnapshot = calls.find((call) => call.sql.includes("comment_interaction_snapshots"));
  const matches = calls.filter((call) => call.sql.includes("brand_post_matches"));
  assert.deepEqual(postSnapshot?.params, [9, 50, null, null, null, null, observedAt]);
  assert.deepEqual(commentSnapshot?.params, [9, 60, null, observedAt]);
  assert.match(postSnapshot?.sql ?? "", /ON DUPLICATE KEY UPDATE id = id/);
  assert.equal(matches.length, 2);
  assert.deepEqual(matches[0]?.params, [2, 3, 5, 50, 9, "Leader"]);
  assert.deepEqual(matches[1]?.params, [2, 3, 6, 50, 9, "型号词"]);
});

test("原始字段先脱敏且拒绝自定义toJSON和BigInt", async () => {
  const rawPayload = {
    noteId: "ordinary-note-id",
    authorizationId: "ordinary-authorization-id",
    xsec_token_id: "ordinary-xsec-id",
    cookie: "cookie-secret",
    nested: {
      a1: "a1-secret",
      "x-s": "xs-secret",
      "x-t": "xt-secret",
      authorization: "authorization-secret",
      deeper: { cookie: "deep-cookie-secret", ordinaryId: "ordinary-deep-id" },
      password: "password-secret",
      text: "联系 13800138000",
      headers: "Cookie: header-cookie-secret\nAuthorization: Bearer header-auth-secret\nX-S: header-xs-secret",
      url: "https://example.test/path?a1=url-a1-secret&x-s=url-xs-secret&x-t=url-xt-secret&cookie=url-cookie-secret&authorization=url-auth-secret&tab=1"
    }
  };
  const serialized = serializeSanitizedPayload(rawPayload);
  assert.equal(serialized.includes("ordinary-note-id"), true);
  assert.equal(serialized.includes("ordinary-authorization-id"), true);
  assert.equal(serialized.includes("ordinary-xsec-id"), true);
  assert.equal(serialized.includes("ordinary-deep-id"), true);
  for (const secret of [
    "cookie-secret",
    "a1-secret",
    "xs-secret",
    "xt-secret",
    "authorization-secret",
    "deep-cookie-secret",
    "password-secret",
    "13800138000",
    "header-cookie-secret",
    "header-auth-secret",
    "header-xs-secret",
    "url-a1-secret",
    "url-xs-secret",
    "url-xt-secret",
    "url-cookie-secret",
    "url-auth-secret"
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.match(serialized, /\[redacted-phone\]/);
  assert.match(serialized, /Cookie: \[redacted\]/);
  assert.match(serialized, /Authorization: \[redacted\]/);
  assert.match(serialized, /X-S: \[redacted\]/);
  for (const parameter of ["a1", "x-s", "x-t", "cookie", "authorization"]) {
    assert.equal(serialized.includes(`${parameter}=[redacted]`), true);
  }

  assert.throws(
    () => serializeSanitizedPayload({ value: "safe", toJSON: () => ({ leaked: true }) }),
    (error: unknown) => error instanceof PersistenceError && error.errorType === "raw_snapshot_sanitize_failed"
  );
  assert.throws(
    () => serializeSanitizedPayload({ value: 1n }),
    (error: unknown) => error instanceof PersistenceError && error.errorType === "raw_snapshot_sanitize_failed"
  );

  const repository = new CollectionPersistenceRepository();
  const successful = recordingConnection();
  const item = itemFixture("note-1", { rawPayload });
  await repository.saveRawSnapshots(successful.connection, 9, 50, new Map(), item);
  assert.equal(successful.calls.length, 1);
  assert.match(successful.calls[0]?.sql ?? "", /ON DUPLICATE KEY UPDATE id = id/);
  assert.deepEqual(successful.calls[0]?.params, [9, 50, serialized, "xhs-probe-v1", item.observedAt]);

  const failed = recordingConnection();
  await assert.rejects(
    () => repository.saveRawSnapshots(failed.connection, 9, 50, new Map(), itemFixture("note-1", { rawPayload: { value: 1n } })),
    (error: unknown) => error instanceof PersistenceError && error.errorType === "raw_snapshot_sanitize_failed"
  );
  assert.equal(failed.calls.length, 0);
});

interface TransactionState {
  began: boolean;
  committed: boolean;
  rolledBack: boolean;
  released: boolean;
  destroyed: boolean;
}

function batchPool(failingConnection: number | null, rollbackFailingConnection: number | null = null): {
  pool: Pool;
  taskCalls: SqlCall[];
  transactions: TransactionState[];
} {
  const taskCalls: SqlCall[] = [];
  const transactions: TransactionState[] = [];
  let connectionIndex = 0;
  const pool = {
    execute: async (sql: string, params: unknown[] = []) => {
      taskCalls.push({ sql, params });
      return [{ affectedRows: 1, insertId: 1 }, []];
    },
    getConnection: async () => {
      connectionIndex += 1;
      const current = connectionIndex;
      const state = { began: false, committed: false, rolledBack: false, released: false, destroyed: false };
      transactions.push(state);
      return {
        beginTransaction: async () => { state.began = true; },
        commit: async () => { state.committed = true; },
        rollback: async () => {
          state.rolledBack = true;
          if (rollbackFailingConnection === current) throw new Error("rollback failed");
        },
        release: () => { state.released = true; },
        destroy: () => { state.destroyed = true; },
        execute: async (sql: string) => {
          if (failingConnection === current && sql.includes("post_interaction_snapshots")) {
            throw new Error("database details must not escape");
          }
          if (sql.includes("INSERT INTO posts")) return [{ affectedRows: 1, insertId: current * 10 }, []];
          return [{ affectedRows: 1, insertId: 1 }, []];
        }
      } as unknown as PoolConnection;
    }
  } as unknown as Pool;
  return { pool, taskCalls, transactions };
}

test("批量持久化按单篇提交或回滚并记录partial_success计数", async () => {
  const { pool, taskCalls, transactions } = batchPool(2);
  const service = new CollectionPersistenceService(pool);
  const result = await service.persistBatch({
    taskId: 9,
    dataSourceId: 2,
    brandId: 3,
    items: [itemFixture("success-note"), itemFixture("failed-note")]
  });

  assert.deepEqual(result, {
    taskId: 9,
    status: "partial_success",
    succeededPostCount: 1,
    failedPostCount: 1,
    failures: [{ noteId: "failed-note", errorType: "database_write_failed" }]
  });
  assert.deepEqual(transactions, [
    { began: true, committed: true, rolledBack: false, released: true, destroyed: false },
    { began: true, committed: false, rolledBack: true, released: true, destroyed: false }
  ]);
  const finish = taskCalls.find((call) => call.sql.includes("succeeded_post_count"));
  assert.deepEqual(finish?.params, [
    "partial_success",
    1,
    1,
    "database_write_failed",
    "单篇采集内容持久化失败。",
    9
  ]);
  assert.equal(JSON.stringify(result).includes("database details"), false);
});

test("回滚失败时销毁连接且不放回连接池", async () => {
  const { pool, transactions } = batchPool(1, 1);
  const service = new CollectionPersistenceService(pool);
  const result = await service.persistBatch({
    taskId: 12,
    dataSourceId: 2,
    brandId: 3,
    items: [itemFixture("rollback-failed-note")]
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(transactions, [{
    began: true,
    committed: false,
    rolledBack: true,
    released: false,
    destroyed: true
  }]);
});

test("全部内容失败时任务结束为failed且不创建事务连接", async () => {
  const { pool, taskCalls, transactions } = batchPool(null);
  const service = new CollectionPersistenceService(pool);
  const invalid = itemFixture("invalid-note", { post: postFixture({ noteId: "invalid-note", sourceUrl: "   " }) });
  const result = await service.persistBatch({ taskId: 10, dataSourceId: 2, brandId: 3, items: [invalid] });

  assert.equal(result.status, "failed");
  assert.equal(result.succeededPostCount, 0);
  assert.equal(result.failedPostCount, 1);
  assert.deepEqual(result.failures, [{ noteId: "invalid-note", errorType: "input_invalid" }]);
  assert.equal(transactions.length, 0);
  const finish = taskCalls.find((call) => call.sql.includes("succeeded_post_count"));
  assert.deepEqual(finish?.params, ["failed", 0, 1, "input_invalid", "采集内容字段不符合持久化要求。", 10]);
});

test("取得数据前失败和重试任务保留状态约束", async () => {
  const calls: SqlCall[] = [];
  const responses = [
    [{ affectedRows: 1, insertId: 0 }, []],
    [{ affectedRows: 1, insertId: 77 }, []],
    [{ affectedRows: 0, insertId: 0 }, []]
  ];
  const pool = {
    execute: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return responses.shift();
    }
  } as unknown as Pool;
  const tasks = new CollectionTaskRepository(pool);

  await tasks.failBeforeData(11, "database_write_failed");
  const retryTaskId = await tasks.createRetryTask(11);
  assert.equal(retryTaskId, 77);
  assert.match(calls[0]?.sql ?? "", /status = 'failed'/);
  assert.deepEqual(calls[0]?.params, ["database_write_failed", "采集任务在取得内容前失败。", 11]);
  assert.match(calls[1]?.sql ?? "", /retry_of_task_id/);
  assert.match(calls[1]?.sql ?? "", /status IN \('failed', 'partial_success'\)/);
  assert.deepEqual(calls[1]?.params, [11]);
  await assert.rejects(
    () => tasks.createRetryTask(12),
    (error: unknown) => error instanceof PersistenceError && error.errorType === "task_state_conflict"
  );
});

test("已经运行的任务不能再次start", async () => {
  const calls: SqlCall[] = [];
  const pool = {
    execute: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return [{ affectedRows: 0, insertId: 0 }, []];
    }
  } as unknown as Pool;
  const tasks = new CollectionTaskRepository(pool);

  await assert.rejects(
    () => tasks.startTask(9, 2, 3),
    (error: unknown) => error instanceof PersistenceError
      && error.errorType === "task_state_conflict"
      && error.message === "task_not_startable"
  );
  assert.match(calls[0]?.sql ?? "", /status = 'queued'/);
  assert.doesNotMatch(calls[0]?.sql ?? "", /status IN \('queued', 'running'\)/);
  assert.deepEqual(calls[0]?.params, [9, 2, 3]);
});
