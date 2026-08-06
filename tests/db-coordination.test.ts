import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "mysql2/promise";
import {
  acquireBrandLease,
  advanceCollectionCursor,
  releaseBrandLease,
  renewBrandLease,
  type DatabaseExecutor
} from "../src/db/coordination/index.js";

interface SqlCall {
  sql: string;
  params: unknown[];
}

function fakeExecutor(
  execute: (sql: string, params: unknown[]) => Promise<unknown>
): { executor: DatabaseExecutor; calls: SqlCall[] } {
  const calls: SqlCall[] = [];
  const executor = {
    execute: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return execute(sql, params);
    }
  } as unknown as Pool;
  return { executor, calls };
}

const leaseInput = {
  dataSourceId: 2,
  brandId: 3,
  taskId: 9,
  ownerToken: "11111111-1111-4111-8111-111111111111",
  leaseDurationMs: 30_000
};

test("租约首次申请和过期接管由affectedRows区分", async () => {
  const leaseExpiresAt = new Date("2026-08-06T04:05:06.789Z");
  for (const [affectedRows, outcome] of [[1, "acquired"], [2, "taken_over"]] as const) {
    const { executor, calls } = fakeExecutor(async (sql) => {
      if (sql.includes("INSERT INTO collection_locks")) return [{ affectedRows, insertId: 50 }, []];
      if (sql.includes("SELECT status FROM collection_tasks")) return [[{ status: "queued" }], []];
      return [[{
        ownerToken: leaseInput.ownerToken,
        taskId: String(leaseInput.taskId),
        leaseExpiresAt,
        acquiredAt: new Date()
      }], []];
    });
    const result = await acquireBrandLease(executor, leaseInput);

    assert.deepEqual(result, { acquired: true, outcome, leaseExpiresAt });
    const acquireSql = calls[0]?.sql ?? "";
    assert.match(acquireSql, /collection_locks\.lease_expires_at <= UTC_TIMESTAMP\(3\)/);
    assert.match(acquireSql, /ON DUPLICATE KEY UPDATE/);
    assert.match(acquireSql, /WHERE eligible_task\.id = \?/);
    assert.match(acquireSql, /eligible_task\.data_source_id = \?/);
    assert.match(acquireSql, /eligible_task\.brand_id = \?/);
    assert.match(acquireSql, /CONVERT\(\? USING ascii\) COLLATE ascii_bin AS incoming_owner_token/);
    assert.doesNotMatch(acquireSql, /VALUES\s*\(/);
    const updateExpressions = acquireSql
      .split("ON DUPLICATE KEY UPDATE")[1]
      ?.replace(/^\s*[a-z_]+\s*=/gm, "") ?? "";
    assert.doesNotMatch(updateExpressions, /(?<![.\w])(id|data_source_id|brand_id)(?!\w)/);
    assert.deepEqual(calls[0]?.params, [
      2,
      3,
      "11111111-1111-4111-8111-111111111111",
      30_000_000,
      9,
      2,
      3
    ]);
    assert.deepEqual(calls.find((call) => call.sql.includes("SELECT status"))?.params, [9, 2, 3]);
    assert.deepEqual(calls.find((call) => call.sql.includes("FROM collection_locks"))?.params, [2, 3]);
  }
});

test("活跃租约拒绝其他token且不把旧锁当成新锁", async () => {
  const leaseExpiresAt = new Date("2026-08-06T04:05:06.789Z");
  const { executor } = fakeExecutor(async (sql) => {
    if (sql.includes("INSERT INTO collection_locks")) return [{ affectedRows: 0, insertId: 0 }, []];
    if (sql.includes("SELECT status FROM collection_tasks")) return [[{ status: "running" }], []];
    return [[{
      ownerToken: "22222222-2222-4222-8222-222222222222",
      taskId: 8,
      leaseExpiresAt,
      acquiredAt: new Date()
    }], []];
  });
  assert.deepEqual(await acquireBrandLease(executor, leaseInput), {
    acquired: false,
    outcome: "rejected",
    reason: "active_lease",
    leaseExpiresAt
  });
});

test("旧token不能续租或释放已被接管的锁", async () => {
  const { executor, calls } = fakeExecutor(async () => [{ affectedRows: 0 }, []]);

  assert.deepEqual(await renewBrandLease(executor, {
    dataSourceId: 2,
    brandId: 3,
    taskId: 8,
    ownerToken: "22222222-2222-4222-8222-222222222222",
    leaseDurationMs: 30_000
  }), { renewed: false, reason: "not_owner_or_expired" });
  assert.deepEqual(await releaseBrandLease(executor, {
    dataSourceId: 2,
    brandId: 3,
    taskId: 8,
    ownerToken: "22222222-2222-4222-8222-222222222222"
  }), { released: false, reason: "not_owner" });

  assert.match(calls[0]?.sql ?? "", /owner_token = \?/);
  assert.match(calls[0]?.sql ?? "", /lease_expires_at > UTC_TIMESTAMP\(3\)/);
  assert.match(calls[0]?.sql ?? "", /task_id = \?/);
  assert.deepEqual(calls[0]?.params, [30_000_000, 2, 3, 8, "22222222-2222-4222-8222-222222222222"]);
  assert.match(calls[1]?.sql ?? "", /^DELETE FROM collection_locks/);
  assert.match(calls[1]?.sql ?? "", /task_id = \?/);
  assert.deepEqual(calls[1]?.params, [2, 3, 8, "22222222-2222-4222-8222-222222222222"]);
});

test("当前token能够续租并释放锁", async () => {
  const leaseExpiresAt = new Date("2026-08-06T05:06:07.890Z");
  let call = 0;
  const { executor } = fakeExecutor(async () => {
    call += 1;
    if (call === 1) return [{ affectedRows: 1 }, []];
    if (call === 2) return [[{ leaseExpiresAt }], []];
    return [{ affectedRows: 1 }, []];
  });

  assert.deepEqual(await renewBrandLease(executor, {
    dataSourceId: 2,
    brandId: 3,
    taskId: 9,
    ownerToken: "33333333-3333-4333-8333-333333333333",
    leaseDurationMs: 1_500
  }), { renewed: true, leaseExpiresAt });
  assert.deepEqual(await releaseBrandLease(executor, {
    dataSourceId: 2,
    brandId: 3,
    taskId: 9,
    ownerToken: "33333333-3333-4333-8333-333333333333"
  }), { released: true });
});

test("非UUID ownerToken在查询数据库前被拒绝", async () => {
  const { executor, calls } = fakeExecutor(async () => {
    throw new Error("executor must not be called");
  });
  await assert.rejects(
    () => acquireBrandLease(executor, { ...leaseInput, ownerToken: "not-a-uuid" }),
    /ownerToken must be a valid UUID/
  );
  await assert.rejects(
    () => renewBrandLease(executor, {
      dataSourceId: 2,
      brandId: 3,
      taskId: 9,
      ownerToken: "not-a-uuid",
      leaseDurationMs: 1_000
    }),
    /ownerToken must be a valid UUID/
  );
  await assert.rejects(
    () => releaseBrandLease(executor, {
      dataSourceId: 2,
      brandId: 3,
      taskId: 9,
      ownerToken: "not-a-uuid"
    }),
    /ownerToken must be a valid UUID/
  );
  assert.equal(calls.length, 0);
});

test("失败阶段游标直接拒绝且不查询数据库", async () => {
  const { executor, calls } = fakeExecutor(async () => {
    throw new Error("executor must not be called");
  });
  const result = await advanceCollectionCursor(executor, {
    dataSourceId: 2,
    brandId: 3,
    stageCode: "search",
    cursorValue: { page: 2 },
    taskId: 9,
    expectedCursorVersion: 0,
    stageOutcome: "failed"
  });

  assert.deepEqual(result, { advanced: false, reason: "stage_failed" });
  assert.equal(calls.length, 0);
});

test("expectedCursorVersion为0时只用INSERT创建游标", async () => {
  const { executor, calls } = fakeExecutor(async () => [{ affectedRows: 1, insertId: 50 }, []]);
  const result = await advanceCollectionCursor(executor, {
    dataSourceId: 2,
    brandId: 3,
    stageCode: "search",
    scopeKey: "Leader",
    cursorValue: { page: 2, token: "safe-cursor" },
    taskId: 9,
    expectedCursorVersion: 0,
    stageOutcome: "success"
  });

  assert.deepEqual(result, { advanced: true, action: "created", cursorVersion: 1 });
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.sql ?? "", /^INSERT INTO collection_cursors/);
  assert.doesNotMatch(calls[0]?.sql ?? "", /^UPDATE collection_cursors/);
  assert.deepEqual(calls[0]?.params, [
    2,
    3,
    "search",
    "Leader",
    JSON.stringify({ page: 2, token: "safe-cursor" }),
    9,
    2,
    3
  ]);
});

test("新建游标冲突时INSERT保持无副作用并返回stale_cursor", async () => {
  const { executor, calls } = fakeExecutor(async (sql) => {
    if (sql.includes("INSERT INTO collection_cursors")) return [{ affectedRows: 0, insertId: 0 }, []];
    return [[{ status: "running" }], []];
  });
  const result = await advanceCollectionCursor(executor, {
    dataSourceId: 2,
    brandId: 3,
    stageCode: "search",
    cursorValue: { page: 1 },
    taskId: 9,
    expectedCursorVersion: 0,
    stageOutcome: "success"
  });

  assert.deepEqual(result, { advanced: false, reason: "stale_cursor" });
  assert.equal(calls.filter((call) => /^(?:INSERT|UPDATE)/.test(call.sql)).length, 1);
  assert.match(calls[0]?.sql ?? "", /^INSERT INTO collection_cursors/);
  const createSql = calls[0]?.sql ?? "";
  assert.match(
    createSql,
    /ON DUPLICATE KEY UPDATE id = collection_cursors\.id \+ \(LAST_INSERT_ID\(0\) \* 0\)/
  );
  const duplicateExpression = createSql.split("ON DUPLICATE KEY UPDATE id =")[1] ?? "";
  assert.doesNotMatch(duplicateExpression, /(?<![.\w])id(?!\w)/);
  assert.equal(calls.some((call) => /^UPDATE collection_cursors/.test(call.sql)), false);
  assert.equal(calls.some((call) => /FROM collection_cursors/.test(call.sql)), false);
});

test("expectedCursorVersion大于0时只用带版本条件的UPDATE", async () => {
  const { executor, calls } = fakeExecutor(async () => [{ affectedRows: 1, insertId: 50 }, []]);
  const result = await advanceCollectionCursor(executor, {
    dataSourceId: 2,
    brandId: 3,
    stageCode: "search",
    scopeKey: "Leader",
    cursorValue: { page: 3 },
    taskId: 9,
    expectedCursorVersion: 3,
    stageOutcome: "success"
  });

  assert.deepEqual(result, { advanced: true, action: "updated", cursorVersion: 4 });
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.sql ?? "", /^UPDATE collection_cursors\s+SET/);
  assert.doesNotMatch(calls[0]?.sql ?? "", /SET\s+cursor\./);
  assert.match(calls[0]?.sql ?? "", /SET cursor_value = CAST\(\? AS JSON\)/);
  assert.match(calls[0]?.sql ?? "", /AND collection_cursors\.cursor_version = \?/);
  assert.match(calls[0]?.sql ?? "", /AND EXISTS \(\s+SELECT 1 FROM collection_tasks/);
  assert.match(calls[0]?.sql ?? "", /collection_tasks\.status IN \('running', 'success', 'partial_success'\)/);
  assert.doesNotMatch(calls[0]?.sql ?? "", /^INSERT INTO collection_cursors/);
  assert.deepEqual(calls[0]?.params, [
    JSON.stringify({ page: 3 }),
    9,
    2,
    3,
    "search",
    "Leader",
    3,
    9,
    2,
    3
  ]);
});

test("更新目标不存在或版本冲突时返回stale_cursor且不插入", async () => {
  const { executor, calls } = fakeExecutor(async (sql) => {
    if (sql.includes("UPDATE collection_cursors")) return [{ affectedRows: 0, insertId: 0 }, []];
    if (sql.includes("SELECT status FROM collection_tasks")) return [[{ status: "success" }], []];
    throw new Error(`unexpected query: ${sql}`);
  });
  const result = await advanceCollectionCursor(executor, {
    dataSourceId: 2,
    brandId: 3,
    stageCode: "comments",
    cursorValue: { offset: 20 },
    taskId: 9,
    expectedCursorVersion: 2,
    stageOutcome: "success"
  });

  assert.deepEqual(result, { advanced: false, reason: "stale_cursor" });
  assert.match(calls[0]?.sql ?? "", /^UPDATE collection_cursors\s+SET/);
  assert.doesNotMatch(calls[0]?.sql ?? "", /SET\s+cursor\./);
  assert.match(calls[0]?.sql ?? "", /collection_cursors\.cursor_version = \?/);
  assert.match(calls[0]?.sql ?? "", /AND EXISTS \(\s+SELECT 1 FROM collection_tasks/);
  assert.equal(calls.some((call) => /^INSERT INTO collection_cursors/.test(call.sql)), false);
  assert.equal(calls.some((call) => /FROM collection_cursors/.test(call.sql)), false);
});

test("非运行或成功任务不能推进游标", async () => {
  const { executor } = fakeExecutor(async (sql) => {
    if (sql.includes("INSERT INTO collection_cursors")) return [{ affectedRows: 0, insertId: 0 }, []];
    if (sql.includes("SELECT status FROM collection_tasks")) return [[{ status: "failed" }], []];
    return [[], []];
  });
  const result = await advanceCollectionCursor(executor, {
    dataSourceId: 2,
    brandId: 3,
    stageCode: "detail",
    cursorValue: null,
    taskId: 9,
    expectedCursorVersion: 0,
    stageOutcome: "success"
  });

  assert.deepEqual(result, { advanced: false, reason: "task_not_eligible" });
});
