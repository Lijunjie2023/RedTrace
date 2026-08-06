import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "mysql2/promise";
import { MysqlRepository } from "../apps/api/src/repositories/mysql.js";

test("LIVE帖子筛选在COUNT和分页SQL中使用人工修正优先的有效分析", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return calls.length === 1 ? [[{ total: 0 }], []] : [[], []];
    }
  } as unknown as Pool;
  const repository = new MysqlRepository(pool);
  const result = await repository.listContents({
    page: 1,
    pageSize: 20,
    sortOrder: "DESC",
    contentType: "POST",
    sentiments: ["NEGATIVE"],
    categoryIds: ["1"],
    problemTypeIds: ["2"],
    topicIds: ["3"],
    contentNatures: ["COMPLAINT"],
    riskLevels: ["WATCH"],
    productSeries: "系列A",
    productModel: "型号B"
  });

  assert.equal(result.totalItems, 0);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.match(call.sql, /manual_corrections/);
    assert.match(call.sql, /analysis_records/);
    assert.match(call.sql, /analysis_problem_types/);
    assert.match(call.sql, /analysis_topics/);
    assert.match(call.sql, /JSON_OVERLAPS/);
  }
  assert.deepEqual(calls[0]!.params, ["NEGATIVE", "1", "COMPLAINT", "WATCH", "系列A", "型号B", "2", "2", "3", "3"]);
  assert.deepEqual(calls[1]!.params.slice(0, -2), calls[0]!.params);
  assert.deepEqual(calls[1]!.params.slice(-2), [20, 0]);
});
