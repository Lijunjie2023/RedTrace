import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "mysql2/promise";
import { MysqlAnalysisStore } from "../src/analysis/mysql-store.js";
import type { AnalysisRequest } from "../src/analysis/types.js";

const request: AnalysisRequest = {
  idempotencyKey: "a".repeat(64),
  inputDigest: "b".repeat(64),
  taxonomyDigest: "c".repeat(64),
  promptVersion: "content-analysis-v1",
  modelName: "deepseek-v4-flash",
  candidate: {
    contentType: "POST",
    contentId: "10",
    postId: "10",
    title: "样本",
    text: "样本文本",
    tags: [],
    brandNames: ["Leader"],
    postTitle: null,
    postContext: null,
    parentCommentText: null
  }
};

function poolWithAffectedRows(values: number[]): { pool: Pool; statements: string[] } {
  const statements: string[] = [];
  const pool = {
    execute: async (sql: string) => {
      statements.push(sql);
      return [{ affectedRows: values.shift() ?? 0 }, []];
    }
  } as unknown as Pool;
  return { pool, statements };
}

test("新分析记录通过INSERT IGNORE原子领取且不执行接管UPDATE", async () => {
  const state = poolWithAffectedRows([1]);
  const store = new MysqlAnalysisStore(state.pool);
  const claimed = await store.startAttempt(request, "11111111-1111-4111-8111-111111111111", 180_000);
  assert.equal(claimed, true);
  assert.equal(state.statements.length, 1);
  assert.match(state.statements[0]!, /INSERT IGNORE INTO analysis_records/);
});

test("活跃租约不能被第二个执行者领取", async () => {
  const state = poolWithAffectedRows([0, 0]);
  const store = new MysqlAnalysisStore(state.pool);
  const claimed = await store.startAttempt(request, "22222222-2222-4222-8222-222222222222", 180_000);
  assert.equal(claimed, false);
  assert.equal(state.statements.length, 2);
  assert.match(state.statements[1]!, /status = 'failed' OR lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP\(3\)/);
});

test("失败或过期租约能够由条件UPDATE接管", async () => {
  const state = poolWithAffectedRows([0, 1]);
  const store = new MysqlAnalysisStore(state.pool);
  const claimed = await store.startAttempt(request, "33333333-3333-4333-8333-333333333333", 180_000);
  assert.equal(claimed, true);
  assert.match(state.statements[1]!, /DATE_ADD\(CURRENT_TIMESTAMP\(3\), INTERVAL \? MICROSECOND\)/);
});
