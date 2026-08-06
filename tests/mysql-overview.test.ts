import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { MysqlRepository } from "../apps/api/src/repositories/mysql.js";

const defaultOptions = { page: 1, pageSize: 20 as const, sortOrder: "DESC" as const };

function poolWithQuery(query: (sql: string) => RowDataPacket[]): Pool {
  return {
    query: async (sql: string) => [query(sql), []],
    end: async () => undefined
  } as unknown as Pool;
}

test("MySQL 概览在没有成功采集时返回可渲染的空状态", async () => {
  const repository = new MysqlRepository(poolWithQuery(() => []));

  const overview = await repository.getOverview(defaultOptions);

  assert.deepEqual(overview.metrics, {
    postCount: null,
    commentCount: null,
    negativeCount: null,
    negativeRatio: null
  });
  assert.equal(overview.collectionHealth, "NOT_COLLECTED");
  assert.equal(overview.lastSuccessfulCollectionAt, null);
  assert.deepEqual(overview.sentimentTrend, []);
  assert.deepEqual(overview.highRiskContents, []);
});

test("MySQL 概览使用真实聚合结果并保留健康状态", async () => {
  const repository = new MysqlRepository(poolWithQuery((sql) => {
    if (sql.includes("FROM collection_tasks")) {
      return [{ status: "success", finished_at: "2026-08-06T02:30:00.000Z" }] as RowDataPacket[];
    }
    if (sql.includes("AS post_count") && sql.includes("FROM effective_content")) {
      return [{ post_count: 2, comment_count: 3, negative_count: 2 }] as RowDataPacket[];
    }
    if (sql.includes("DATE_FORMAT(bucket_at")) {
      return [{ bucket: "2026-08-06", positive: 1, neutral: 1, negative: 2, unknown_count: 1 }] as RowDataPacket[];
    }
    if (sql.includes("INNER JOIN matched_brands")) {
      return [{ brand_id: 1, brand_name: "Leader", content_count: 5, negative_count: 2 }] as RowDataPacket[];
    }
    if (sql.includes("classification_type = 'category'")) {
      return [{ category_id: 11, category_name: "冰箱", content_count: 3 }] as RowDataPacket[];
    }
    if (sql.includes("classification_type = 'problem_type'")) {
      return [{ problem_type_id: 21, problem_type_name: "噪音", content_count: 2 }] as RowDataPacket[];
    }
    if (sql.includes("classification_type = 'topic'")) {
      return [{ topic_id: 31, topic_name: "噪音体验", evidence_count: 2 }] as RowDataPacket[];
    }
    if (sql.includes("SELECT content_type, content_id")) return [];
    throw new Error(`未覆盖的测试查询：${sql}`);
  }));

  const overview = await repository.getOverview(defaultOptions);

  assert.deepEqual(overview.metrics, {
    postCount: 2,
    commentCount: 3,
    negativeCount: 2,
    negativeRatio: 0.4
  });
  assert.equal(overview.collectionHealth, "HEALTHY");
  assert.equal(overview.lastSuccessfulCollectionAt, "2026-08-06T02:30:00.000Z");
  assert.deepEqual(overview.sentimentTrend, [{
    bucket: "2026-08-06",
    positive: 1,
    neutral: 1,
    negative: 2,
    unknown: 1
  }]);
  assert.deepEqual(overview.brandRanking[0], {
    brandId: "1",
    brandName: "Leader",
    contentCount: 5,
    negativeCount: 2
  });
  assert.equal(overview.categoryRanking[0]?.categoryName, "冰箱");
  assert.equal(overview.problemTypeRanking[0]?.problemTypeName, "噪音");
  assert.deepEqual(overview.risingTopics[0], {
    topicId: "31",
    topicName: "噪音体验",
    changeRatio: null,
    evidenceCount: 2
  });
});
