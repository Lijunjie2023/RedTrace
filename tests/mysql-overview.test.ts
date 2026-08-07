import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { MysqlRepository } from "../apps/api/src/repositories/mysql.js";
import { isWithinDateRange, overviewDateBuckets } from "../apps/api/src/repositories/overview-trend.js";
import { RepositoryError } from "../apps/api/src/repositories/types.js";

const defaultOptions = { page: 1, pageSize: 20 as const, sortOrder: "DESC" as const };

function poolWithQuery(query: (sql: string) => RowDataPacket[]): Pool {
  return {
    query: async (sql: string) => [query(sql), []],
    end: async () => undefined
  } as unknown as Pool;
}

function poolWithParams(query: (sql: string, params: unknown[]) => RowDataPacket[]): Pool {
  return {
    query: async (sql: string, params?: unknown) => [query(sql, Array.isArray(params) ? params : []), []],
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
    if (sql.includes("DATE_FORMAT(CONVERT_TZ(bucket_at")) {
      assert.match(sql, /DATE_FORMAT\(CONVERT_TZ\(bucket_at, '\+00:00', '\+08:00'\), '%Y-%m-%d'\)/);
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
      return [{
        topic_id: 31,
        topic_name: "噪音体验",
        evidence_count: 4,
        affected_post_count: 3,
        comment_count: 2,
        previous_evidence_count: 2
      }] as RowDataPacket[];
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
    changeRatio: 1,
    evidenceCount: 4,
    affectedPostCount: 3,
    commentCount: 2
  });
});

test("MySQL 概览把品牌和品类筛选传入同一统计范围", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const repository = new MysqlRepository(poolWithParams((sql, params) => {
    calls.push({ sql, params });
    if (sql.includes("FROM collection_tasks")) {
      return [{ status: "success", finished_at: "2026-08-06T02:30:00.000Z" }] as RowDataPacket[];
    }
    return [];
  }));

  await repository.getOverview({
    ...defaultOptions,
    brandIds: ["brand-leader"],
    categoryIds: ["category-fridge"]
  });

  const scopedCalls = calls.filter(({ sql }) => sql.includes("effective_content"));
  assert.ok(scopedCalls.length > 0);
  for (const call of scopedCalls) {
    assert.match(call.sql, /unfiltered_effective_content/);
    assert.match(call.sql, /WHERE category_id IN \(\?\)/);
    assert.ok(call.params.includes("brand-leader"));
    assert.ok(call.params.includes("category-fridge"));
  }
});

test("MySQL 概览按已选自然日补齐没有内容的趋势日期", async () => {
  const repository = new MysqlRepository(poolWithQuery((sql) => {
    if (sql.includes("FROM collection_tasks")) {
      return [{ status: "success", finished_at: "2026-08-06T02:30:00.000Z" }] as RowDataPacket[];
    }
    if (sql.includes("DATE_FORMAT(CONVERT_TZ(bucket_at")) {
      return [{ bucket: "2026-08-05", positive: 0, neutral: 0, negative: 2, unknown_count: 0 }] as RowDataPacket[];
    }
    return [];
  }));

  const overview = await repository.getOverview({
    ...defaultOptions,
    from: "2026-08-04T00:00:00+08:00",
    to: "2026-08-06T23:59:59+08:00"
  });

  assert.deepEqual(overview.sentimentTrend, [
    { bucket: "2026-08-04", positive: 0, neutral: 0, negative: 0, unknown: 0 },
    { bucket: "2026-08-05", positive: 0, neutral: 0, negative: 2, unknown: 0 },
    { bucket: "2026-08-06", positive: 0, neutral: 0, negative: 0, unknown: 0 }
  ]);
});

test("MySQL 热榜按去重帖子、直接命中评论和紧邻等长上期聚合", async () => {
  let checkedTopicQuery = false;
  const repository = new MysqlRepository(poolWithParams((sql, params) => {
    if (sql.includes("FROM collection_tasks")) {
      return [{ status: "success", finished_at: "2026-08-07T02:30:00.000Z" }] as RowDataPacket[];
    }
    if (sql.includes("classification_type = 'topic'")) {
      checkedTopicQuery = true;
      assert.match(sql, /COUNT\(DISTINCT CASE WHEN ec\.comparison_period = 'current' THEN ec\.post_id END\) AS affected_post_count/);
      assert.match(sql, /SUM\(ec\.comparison_period = 'current'\s+AND ec\.content_type = _ascii'COMMENT' COLLATE ascii_bin\) AS comment_count/);
      assert.deepEqual(params.slice(-4), [
        "2026-08-01T00:00:00+08:00",
        "2026-08-07T23:59:59+08:00",
        "2026-07-24T16:00:00.000Z",
        "2026-07-31T15:59:59.000Z"
      ]);
    }
    return [];
  }));

  await repository.getOverview({
    ...defaultOptions,
    from: "2026-08-01T00:00:00+08:00",
    to: "2026-08-07T23:59:59+08:00"
  });

  assert.equal(checkedTopicQuery, true);
});

test("概览日期范围允许366天并拒绝367天", () => {
  const allowed = overviewDateBuckets({
    ...defaultOptions,
    from: "2025-01-01T00:00:00+08:00",
    to: "2026-01-01T23:59:59+08:00"
  });
  assert.equal(allowed?.length, 366);
  assert.throws(
    () => overviewDateBuckets({
      ...defaultOptions,
      from: "2025-01-01T00:00:00+08:00",
      to: "2026-01-02T23:59:59+08:00"
    }),
    (error: unknown) => error instanceof RepositoryError
      && error.code === "VALIDATION_ERROR"
      && error.message === "概览日期范围最多支持366天。"
  );
});

test("概览日期范围要求from和to成对提供", () => {
  for (const options of [
    { ...defaultOptions, from: "2026-08-01T00:00:00+08:00" },
    { ...defaultOptions, to: "2026-08-07T23:59:59+08:00" }
  ]) {
    assert.throws(
      () => overviewDateBuckets(options),
      (error: unknown) => error instanceof RepositoryError
        && error.code === "VALIDATION_ERROR"
        && error.message === "from和to必须同时提供。"
    );
  }
});

test("Mock 日期筛选按时间点比较不受时区字符串排序影响", () => {
  const publishedAt = "2026-08-02T03:00:00.000Z";
  assert.equal(isWithinDateRange(publishedAt, { from: "2026-08-02T10:00:00+08:00" }), true);
  assert.equal(isWithinDateRange(publishedAt, { to: "2026-08-02T10:30:00+08:00" }), false);
});

test("MySQL 数据管理统计映射采集量、AI分类量和异常状态", async () => {
  const repository = new MysqlRepository(poolWithQuery((sql) => {
    assert.match(sql, /latest_analysis_status/);
    assert.match(sql, /COUNT\(DISTINCT post_id\)/);
    assert.match(sql, /COUNT\(DISTINCT comment_id\)/);
    return [{
      total_posts: 12,
      total_comments: 34,
      ai_classified_posts: 10,
      ai_classified_comments: 21,
      analysis_running_count: 2,
      analysis_failed_count: 3,
      manual_correction_count: 4,
      last_analysis_at: "2026-08-06T06:00:00.000Z"
    }] as RowDataPacket[];
  }));

  const summary = await repository.getDataManagementSummary();

  assert.deepEqual(summary, {
    totalPosts: 12,
    totalComments: 34,
    aiClassifiedPosts: 10,
    aiClassifiedComments: 21,
    analysisRunningCount: 2,
    analysisFailedCount: 3,
    manualCorrectionCount: 4,
    lastAnalysisAt: "2026-08-06T06:00:00.000Z"
  });
});

test("MySQL 问题原话与热榜统一限定为负向内容", async () => {
  const evidenceQueries: string[] = [];
  const repository = new MysqlRepository(poolWithParams((sql) => {
    if (sql.includes("SELECT id FROM classification_items")) {
      return [{ id: "topic-noise" }] as RowDataPacket[];
    }
    evidenceQueries.push(sql);
    if (sql.includes("COUNT(*) AS total")) return [{ total: 0 }] as RowDataPacket[];
    return [];
  }));

  const result = await repository.listTopicEvidence("topic-noise", defaultOptions);

  assert.equal(result.totalItems, 0);
  assert.ok(evidenceQueries.length >= 2);
  for (const sql of evidenceQueries) {
    assert.match(sql, /LOWER\(COALESCE\(ec\.sentiment/);
    assert.match(sql, /_ascii'negative'/);
  }
});
