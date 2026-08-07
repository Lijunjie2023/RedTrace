import type { Pool, RowDataPacket } from "mysql2/promise";
import type {
  Brand,
  ClassificationItem,
  CollectionRunCreateInput,
  CollectionTaskSummary,
  CredentialKind,
  ContentDetail,
  ContentSummary,
  DataManagementSummary,
  EffectiveAnalysis,
  OverviewData,
  ServiceCredentialSummary
} from "@readtrace/contracts";
import { createCredentialCrypto, ServiceCredentialRepository } from "../../../../src/credentials/index.js";
import { CollectionTaskRepository } from "../../../../src/db/persistence/index.js";
import { PersistenceError } from "../../../../src/db/persistence/errors.js";
import { runCollectionTask } from "../../../../src/collection/run.js";
import type { BrandCreateInput, CollectionRunPage, DataRepository, ListOptions, OptionalPatch, Page } from "./types.js";
import { RepositoryError, dataNotReady, notImplemented } from "./types.js";
import { completeSentimentTrend, overviewDateBuckets } from "./overview-trend.js";

interface CountRow extends RowDataPacket { total: number }

interface OverviewScope {
  cte: string;
  params: unknown[];
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function page<T>(items: T[], totalItems: number, options: ListOptions): Page<T> {
  return { items, totalItems, page: options.page, pageSize: options.pageSize };
}

function collectionTaskSummary(row: RowDataPacket): CollectionTaskSummary {
  return {
    id: String(row.id),
    brandId: String(row.brand_id),
    triggerType: upper(row.trigger_type),
    keyword: row.keyword === null || row.keyword === undefined ? null : String(row.keyword),
    noteLimit: row.requested_note_limit === null || row.requested_note_limit === undefined
      ? null
      : Number(row.requested_note_limit),
    status: upper(row.status),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    succeededPostCount: Number(row.succeeded_post_count ?? 0),
    failedPostCount: Number(row.failed_post_count ?? 0),
    fetchedPostCount: Number(row.fetched_post_count ?? 0),
    fetchedCommentCount: Number(row.fetched_comment_count ?? 0),
    storedPostCount: Number(row.stored_post_count ?? 0),
    storedCommentCount: Number(row.stored_comment_count ?? 0),
    skippedNoCommentPostCount: Number(row.skipped_no_comment_post_count ?? 0),
    failedCount: Number(row.failed_count ?? 0),
    errorType: row.error_type ?? null,
    errorSummary: row.error_summary ?? null,
    retryOfTaskId: row.retry_of_task_id === null ? null : String(row.retry_of_task_id)
  };
}

function unavailableAnalysis(): EffectiveAnalysis {
  return {
    sentiment: "UNKNOWN",
    contentNature: null,
    problemTypeIds: [],
    categoryId: null,
    productSeries: null,
    productModel: null,
    userStage: null,
    riskLevel: "NORMAL",
    confidence: null,
    topicIds: [],
    analysisOrigin: "UNAVAILABLE",
    modelName: null,
    analyzedAt: null,
    correctedAt: null,
    version: 1
  };
}

interface ResolvedAnalysis {
  effective: EffectiveAnalysis;
  model: EffectiveAnalysis | null;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringIds(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  return value.split(",");
}

function modelAnalysis(row: RowDataPacket): EffectiveAnalysis {
  return {
    sentiment: upper(row.sentiment),
    contentNature: row.content_nature ?? null,
    problemTypeIds: stringIds(row.problem_type_ids),
    categoryId: row.category_id === null ? null : String(row.category_id),
    productSeries: row.product_series ?? null,
    productModel: row.product_model ?? null,
    userStage: row.user_stage ?? null,
    riskLevel: upper(row.risk_level),
    confidence: row.confidence === null ? null : upper<NonNullable<EffectiveAnalysis["confidence"]>>(row.confidence),
    topicIds: stringIds(row.topic_ids),
    analysisOrigin: "MODEL",
    modelName: String(row.model_name),
    analyzedAt: iso(row.completed_at),
    correctedAt: null,
    version: Number(row.id)
  };
}

function applyCorrection(base: EffectiveAnalysis, row: RowDataPacket): EffectiveAnalysis {
  const version = Number(row.version);
  if (row.deleted_at !== null) return { ...base, version };
  const patch = jsonObject(row.patch_json);
  return {
    ...base,
    ...patch,
    analysisOrigin: "HUMAN_OVERRIDE",
    correctedAt: iso(row.corrected_at),
    version
  } as EffectiveAnalysis;
}

function upper<T extends string>(value: string): T {
  return value.toUpperCase() as T;
}

function xiaohongshuSourceUrl(value: unknown): string {
  if (typeof value !== "string") dataNotReady();
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !(url.hostname === "xiaohongshu.com" || url.hostname.endsWith(".xiaohongshu.com"))) {
      dataNotReady();
    }
    return value;
  } catch {
    return dataNotReady();
  }
}

function appendEffectiveAnalysisFilters(
  alias: "p" | "c",
  options: ListOptions,
  clauses: string[],
  params: unknown[]
): void {
  const targetColumn = alias === "p" ? "post_id" : "comment_id";
  const modelScalar = (column: string): string =>
    `(SELECT ar.${column} FROM analysis_records ar
      WHERE ar.${targetColumn} = ${alias}.id AND ar.status = 'success'
      ORDER BY ar.completed_at DESC, ar.id DESC LIMIT 1)`;
  const activePatchHas = (path: string): string =>
    `EXISTS (SELECT 1 FROM manual_corrections mc WHERE mc.${targetColumn} = ${alias}.id
      AND mc.deleted_at IS NULL AND JSON_CONTAINS_PATH(mc.patch_json, 'one', '${path}'))`;
  const patchValue = (path: string): string =>
    `(SELECT NULLIF(JSON_UNQUOTE(JSON_EXTRACT(mc.patch_json, '${path}')), 'null')
      FROM manual_corrections mc WHERE mc.${targetColumn} = ${alias}.id AND mc.deleted_at IS NULL LIMIT 1)`;
  const effectiveScalar = (path: string, column: string): string =>
    `(CASE WHEN ${activePatchHas(path)} THEN ${patchValue(path)} ELSE ${modelScalar(column)} END)`;
  const addIn = (expression: string, values: string[]): void => {
    clauses.push(`${expression} IN (${values.map(() => "?").join(",")})`);
    params.push(...values);
  };
  if (options.sentiments) addIn(`UPPER(${effectiveScalar("$.sentiment", "sentiment")})`, options.sentiments);
  if (options.categoryIds) addIn(effectiveScalar("$.categoryId", "category_id"), options.categoryIds);
  if (options.contentNatures) addIn(effectiveScalar("$.contentNature", "content_nature"), options.contentNatures);
  if (options.riskLevels) addIn(`UPPER(${effectiveScalar("$.riskLevel", "risk_level")})`, options.riskLevels);
  if (options.productSeries) {
    clauses.push(`${effectiveScalar("$.productSeries", "product_series")} = ?`);
    params.push(options.productSeries);
  }
  if (options.productModel) {
    clauses.push(`${effectiveScalar("$.productModel", "product_model")} = ?`);
    params.push(options.productModel);
  }
  const addMultiValue = (
    values: string[],
    path: "$.problemTypeIds" | "$.topicIds",
    relationTable: "analysis_problem_types" | "analysis_topics"
  ): void => {
    const jsonValues = values.map(() => "?").join(",");
    const relationValues = values.map(() => "?").join(",");
    clauses.push(`(
      (${activePatchHas(path)} AND EXISTS (
        SELECT 1 FROM manual_corrections mc WHERE mc.${targetColumn} = ${alias}.id AND mc.deleted_at IS NULL
          AND JSON_OVERLAPS(JSON_EXTRACT(mc.patch_json, '${path}'), JSON_ARRAY(${jsonValues}))
      )) OR
      (NOT ${activePatchHas(path)} AND EXISTS (
        SELECT 1 FROM analysis_records ar
        INNER JOIN ${relationTable} rel ON rel.analysis_record_id = ar.id
        WHERE ar.${targetColumn} = ${alias}.id AND ar.status = 'success'
          AND ar.id = (SELECT ar2.id FROM analysis_records ar2
                       WHERE ar2.${targetColumn} = ${alias}.id AND ar2.status = 'success'
                       ORDER BY ar2.completed_at DESC, ar2.id DESC LIMIT 1)
          AND rel.classification_item_id IN (${relationValues})
      ))
    )`);
    params.push(...values, ...values);
  };
  if (options.problemTypeIds) addMultiValue(options.problemTypeIds, "$.problemTypeIds", "analysis_problem_types");
  if (options.topicIds) addMultiValue(options.topicIds, "$.topicIds", "analysis_topics");
}

function overviewScope(options: ListOptions): OverviewScope {
  const postClauses: string[] = [];
  const postParams: unknown[] = [];
  const appendScope = (alias: "p", clauses: string[], params: unknown[]): void => {
    if (options.from) { clauses.push(`${alias}.published_at >= ?`); params.push(options.from); }
    if (options.to) { clauses.push(`${alias}.published_at <= ?`); params.push(options.to); }
    if (options.brandIds) {
      clauses.push(`EXISTS (
        SELECT 1 FROM brand_post_matches filter_bpm
        WHERE filter_bpm.post_id = ${alias}.id
          AND filter_bpm.brand_id IN (${options.brandIds.map(() => "?").join(",")})
      )`);
      params.push(...options.brandIds);
    }
  };
  appendScope("p", postClauses, postParams);
  const postWhere = postClauses.length ? `WHERE ${postClauses.join(" AND ")}` : "";
  const correctedAsciiValue = (path: string): string =>
    `CAST(JSON_UNQUOTE(JSON_EXTRACT(mc.patch_json, '${path}')) AS CHAR CHARACTER SET ascii) COLLATE ascii_bin`;
  const effectiveAsciiValue = (path: string, column: string): string =>
    `CASE WHEN mc.deleted_at IS NULL AND JSON_CONTAINS_PATH(mc.patch_json, 'one', '${path}')
      THEN NULLIF(${correctedAsciiValue(path)}, _ascii'null' COLLATE ascii_bin)
      ELSE CAST(la.${column} AS CHAR CHARACTER SET ascii) COLLATE ascii_bin END`;
  const correctedCategoryId = correctedAsciiValue("$.categoryId");
  const effectiveCategoryId = `CASE
    WHEN mc.deleted_at IS NULL AND JSON_CONTAINS_PATH(mc.patch_json, 'one', '$.categoryId') THEN
      CASE WHEN ${correctedCategoryId} REGEXP _ascii'^[1-9][0-9]*$' COLLATE ascii_bin
                  AND (CHAR_LENGTH(${correctedCategoryId}) < 20
                    OR (CHAR_LENGTH(${correctedCategoryId}) = 20
                      AND ${correctedCategoryId} <= _ascii'18446744073709551615' COLLATE ascii_bin))
        THEN CAST(${correctedCategoryId} AS UNSIGNED)
        ELSE NULL
      END
    ELSE la.category_id
  END`;

  return {
    cte: `WITH scoped_posts AS (
      SELECT p.id, p.published_at, p.last_collected_at
      FROM posts p
      ${postWhere}
    ), scoped_comments AS (
      SELECT c.id, c.post_id, p.published_at AS bucket_at, c.last_collected_at
      FROM comments c
      INNER JOIN scoped_posts p ON p.id = c.post_id
    ), analysis_candidates AS (
      SELECT ar.*
      FROM analysis_records ar
      INNER JOIN scoped_posts p ON p.id = ar.post_id
      WHERE ar.status = 'success' AND ar.content_type = _ascii'post' COLLATE ascii_bin
      UNION ALL
      SELECT ar.*
      FROM analysis_records ar
      INNER JOIN scoped_comments c ON c.id = ar.comment_id
      WHERE ar.status = 'success' AND ar.content_type = _ascii'comment' COLLATE ascii_bin
    ), latest_analysis AS (
      SELECT ranked.* FROM (
        SELECT ar.*,
               ROW_NUMBER() OVER (
                 PARTITION BY ar.content_type, COALESCE(ar.post_id, ar.comment_id)
                 ORDER BY ar.completed_at DESC, ar.id DESC
               ) AS analysis_rank
        FROM analysis_candidates ar
      ) ranked
      WHERE ranked.analysis_rank = 1
    ), unfiltered_effective_content AS (
      SELECT CAST(_ascii'POST' AS CHAR CHARACTER SET ascii) COLLATE ascii_bin AS content_type,
             p.id AS content_id, p.id AS post_id,
             p.published_at AS bucket_at, p.last_collected_at,
             ${effectiveAsciiValue("$.sentiment", "sentiment")} AS sentiment,
             ${effectiveAsciiValue("$.riskLevel", "risk_level")} AS risk_level,
             ${effectiveCategoryId} AS category_id,
             la.id AS analysis_record_id,
             CASE WHEN mc.deleted_at IS NULL THEN mc.patch_json ELSE NULL END AS patch_json
      FROM scoped_posts p
      LEFT JOIN latest_analysis la ON la.content_type = _ascii'post' COLLATE ascii_bin AND la.post_id = p.id
      LEFT JOIN manual_corrections mc ON mc.post_id = p.id
      UNION ALL
      SELECT CAST(_ascii'COMMENT' AS CHAR CHARACTER SET ascii) COLLATE ascii_bin AS content_type,
             c.id AS content_id, c.post_id, c.bucket_at, c.last_collected_at,
             ${effectiveAsciiValue("$.sentiment", "sentiment")} AS sentiment,
             ${effectiveAsciiValue("$.riskLevel", "risk_level")} AS risk_level,
             ${effectiveCategoryId} AS category_id,
             la.id AS analysis_record_id,
             CASE WHEN mc.deleted_at IS NULL THEN mc.patch_json ELSE NULL END AS patch_json
      FROM scoped_comments c
      LEFT JOIN latest_analysis la ON la.content_type = _ascii'comment' COLLATE ascii_bin AND la.comment_id = c.id
      LEFT JOIN manual_corrections mc ON mc.comment_id = c.id
    ), effective_content AS (
      SELECT * FROM unfiltered_effective_content
      ${options.categoryIds
        ? `WHERE category_id IN (${options.categoryIds.map(() => "?").join(",")})`
        : ""}
    )`,
    params: [...postParams, ...(options.categoryIds ?? [])]
  };
}

export class MysqlRepository implements DataRepository {
  constructor(private readonly pool: Pool) {}

  async close(): Promise<void> {
    await this.pool.end();
  }

  async getOverview(options: ListOptions): Promise<OverviewData> {
    const requestedTrendBuckets = overviewDateBuckets(options);
    const brandClause = options.brandIds
      ? `AND brand_id IN (${options.brandIds.map(() => "?").join(",")})`
      : "";
    const healthParams = options.brandIds ?? [];
    const [lastSuccessfulResult, latestTerminalResult] = await Promise.all([
      this.pool.query<RowDataPacket[]>(
        `SELECT finished_at
         FROM collection_tasks
         WHERE status IN ('success', 'partial_success') ${brandClause}
         ORDER BY finished_at DESC, id DESC
         LIMIT 1`,
        healthParams
      ),
      this.pool.query<RowDataPacket[]>(
        `SELECT status
         FROM collection_tasks
         WHERE status IN ('success', 'partial_success', 'failed') ${brandClause}
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        healthParams
      )
    ]);
    const lastSuccessfulCollectionAt = iso(lastSuccessfulResult[0][0]?.finished_at ?? null);
    if (lastSuccessfulCollectionAt === null) {
      return {
        metrics: { postCount: null, commentCount: null, negativeCount: null, negativeRatio: null },
        sentimentTrend: [], brandRanking: [], categoryRanking: [], problemTypeRanking: [], risingTopics: [],
        highRiskContents: [], collectionHealth: "NOT_COLLECTED", lastSuccessfulCollectionAt: null
      };
    }

    const latestTerminalStatus = latestTerminalResult[0][0]?.status;
    const collectionHealth: OverviewData["collectionHealth"] = latestTerminalStatus === "failed"
      ? "FAILED"
      : latestTerminalStatus === "partial_success" ? "PARTIAL" : "HEALTHY";
    const scope = overviewScope(options);
    const withScope = (query: string): string => `${scope.cte}\n${query}`;
    const classificationMembership = (
      classificationType: "problem_type" | "topic",
      patchPath: "$.problemTypeIds" | "$.topicIds",
      relationTable: "analysis_problem_types" | "analysis_topics"
    ): string => `ci.classification_type = '${classificationType}' AND (
      (JSON_CONTAINS_PATH(ec.patch_json, 'one', '${patchPath}')
        AND JSON_CONTAINS(JSON_EXTRACT(ec.patch_json, '${patchPath}'), JSON_QUOTE(CAST(ci.id AS CHAR))))
      OR
      (NOT JSON_CONTAINS_PATH(COALESCE(ec.patch_json, JSON_OBJECT()), 'one', '${patchPath}')
        AND EXISTS (
          SELECT 1 FROM ${relationTable} relation
          WHERE relation.analysis_record_id = ec.analysis_record_id
            AND relation.classification_item_id = ci.id
        ))
    )`;
    const brandFilter = options.brandIds
      ? `AND b.id IN (${options.brandIds.map(() => "?").join(",")})`
      : "";
    const brandParams = [...scope.params, ...(options.brandIds ?? [])];
    const comparisonPeriod = options.from !== undefined && options.to !== undefined
      ? (() => {
          const currentFromMs = Date.parse(options.from!);
          const currentToMs = Date.parse(options.to!);
          const naturalDayMs = 24 * 60 * 60 * 1000;
          const periodShiftMs = Math.ceil((currentToMs - currentFromMs + 1) / naturalDayMs) * naturalDayMs;
          return {
            currentFrom: options.from!,
            currentTo: options.to!,
            previousFrom: new Date(currentFromMs - periodShiftMs).toISOString(),
            previousTo: new Date(currentToMs - periodShiftMs).toISOString()
          };
        })()
      : null;
    const topicScope = comparisonPeriod
      ? overviewScope({ ...options, from: comparisonPeriod.previousFrom, to: comparisonPeriod.currentTo })
      : scope;
    const topicPeriodCte = comparisonPeriod
      ? `, periodized_topic_content AS (
           SELECT ec.*,
                  CASE
                    WHEN ec.bucket_at >= ? AND ec.bucket_at <= ? THEN 'current'
                    WHEN ec.bucket_at >= ? AND ec.bucket_at <= ? THEN 'previous'
                    ELSE NULL
                  END AS comparison_period
           FROM effective_content ec
           WHERE LOWER(COALESCE(ec.sentiment, _ascii'unknown' COLLATE ascii_bin)) = _ascii'negative' COLLATE ascii_bin
         )`
      : `, periodized_topic_content AS (
           SELECT ec.*, 'current' AS comparison_period
           FROM effective_content ec
           WHERE LOWER(COALESCE(ec.sentiment, _ascii'unknown' COLLATE ascii_bin)) = _ascii'negative' COLLATE ascii_bin
         )`;
    const topicPeriodParams = comparisonPeriod
      ? [
          comparisonPeriod.currentFrom,
          comparisonPeriod.currentTo,
          comparisonPeriod.previousFrom,
          comparisonPeriod.previousTo
        ]
      : [];
    const [metricsResult, trendResult] = await Promise.all([
      this.pool.query<RowDataPacket[]>(withScope(
        `SELECT SUM(content_type = _ascii'POST' COLLATE ascii_bin) AS post_count,
                SUM(content_type = _ascii'COMMENT' COLLATE ascii_bin) AS comment_count,
                SUM(LOWER(COALESCE(sentiment, _ascii'unknown' COLLATE ascii_bin)) = _ascii'negative' COLLATE ascii_bin) AS negative_count
         FROM effective_content`
      ), scope.params),
      this.pool.query<RowDataPacket[]>(withScope(
        `SELECT DATE_FORMAT(CONVERT_TZ(bucket_at, '+00:00', '+08:00'), '%Y-%m-%d') AS bucket,
                SUM(LOWER(COALESCE(sentiment, _ascii'unknown' COLLATE ascii_bin)) = _ascii'positive' COLLATE ascii_bin) AS positive,
                SUM(LOWER(COALESCE(sentiment, _ascii'unknown' COLLATE ascii_bin)) = _ascii'neutral' COLLATE ascii_bin) AS neutral,
                SUM(LOWER(COALESCE(sentiment, _ascii'unknown' COLLATE ascii_bin)) = _ascii'negative' COLLATE ascii_bin) AS negative,
                SUM(sentiment IS NULL OR LOWER(sentiment) = _ascii'unknown' COLLATE ascii_bin) AS unknown_count
         FROM effective_content
         WHERE bucket_at IS NOT NULL
         GROUP BY DATE_FORMAT(CONVERT_TZ(bucket_at, '+00:00', '+08:00'), '%Y-%m-%d')
         ORDER BY bucket`
      ), scope.params)
    ]);
    const [brandResult, categoryResult] = await Promise.all([
      this.pool.query<RowDataPacket[]>(withScope(
        `, matched_brands AS (
           SELECT DISTINCT bpm.brand_id, bpm.post_id
           FROM brand_post_matches bpm
           INNER JOIN scoped_posts p ON p.id = bpm.post_id
         )
         SELECT b.id AS brand_id, b.brand_name,
                COUNT(*) AS content_count,
                SUM(LOWER(COALESCE(ec.sentiment, _ascii'unknown' COLLATE ascii_bin)) = _ascii'negative' COLLATE ascii_bin) AS negative_count
         FROM effective_content ec
         INNER JOIN matched_brands mb ON mb.post_id = ec.post_id
         INNER JOIN brands b ON b.id = mb.brand_id
         WHERE 1 = 1 ${brandFilter}
         GROUP BY b.id, b.brand_name
         ORDER BY negative_count DESC, content_count DESC, b.id
         LIMIT 10`
      ), brandParams),
      this.pool.query<RowDataPacket[]>(withScope(
        `SELECT ci.id AS category_id, ci.display_name AS category_name, COUNT(*) AS content_count
         FROM unfiltered_effective_content ec
         INNER JOIN classification_items ci ON ci.id = ec.category_id AND ci.classification_type = 'category'
         GROUP BY ci.id, ci.display_name
         ORDER BY content_count DESC, ci.sort_order, ci.id
         LIMIT 10`
      ), scope.params)
    ]);
    const [problemTypeResult, topicResult] = await Promise.all([
      this.pool.query<RowDataPacket[]>(withScope(
        `SELECT ci.id AS problem_type_id, ci.display_name AS problem_type_name, COUNT(*) AS content_count
         FROM effective_content ec
         INNER JOIN classification_items ci ON ${classificationMembership("problem_type", "$.problemTypeIds", "analysis_problem_types")}
         WHERE LOWER(COALESCE(ec.sentiment, _ascii'unknown' COLLATE ascii_bin)) = _ascii'negative' COLLATE ascii_bin
         GROUP BY ci.id, ci.display_name
         ORDER BY content_count DESC, ci.sort_order, ci.id
         LIMIT 10`
      ), scope.params),
      this.pool.query<RowDataPacket[]>(`${topicScope.cte}\n${topicPeriodCte}
        SELECT ci.id AS topic_id, ci.display_name AS topic_name,
               SUM(ec.comparison_period = 'current') AS evidence_count,
               COUNT(DISTINCT CASE WHEN ec.comparison_period = 'current' THEN ec.post_id END) AS affected_post_count,
               SUM(ec.comparison_period = 'current'
                   AND ec.content_type = _ascii'COMMENT' COLLATE ascii_bin) AS comment_count,
               ${comparisonPeriod
                 ? "SUM(ec.comparison_period = 'previous')"
                 : "NULL"} AS previous_evidence_count
         FROM periodized_topic_content ec
         INNER JOIN classification_items ci ON ${classificationMembership("topic", "$.topicIds", "analysis_topics")}
         GROUP BY ci.id, ci.display_name
         HAVING evidence_count > 0
         ORDER BY evidence_count DESC, ci.sort_order, ci.id
         LIMIT 10`, [...topicScope.params, ...topicPeriodParams])
    ]);
    const highRiskResult = await this.pool.query<RowDataPacket[]>(withScope(
      `SELECT content_type, content_id
       FROM effective_content
       WHERE LOWER(COALESCE(risk_level, _ascii'normal' COLLATE ascii_bin)) = _ascii'high_risk' COLLATE ascii_bin
       ORDER BY last_collected_at DESC, content_type, content_id DESC
       LIMIT 8`
    ), scope.params);

    const metricsRow = metricsResult[0][0];
    const postCount = Number(metricsRow?.post_count ?? 0);
    const commentCount = Number(metricsRow?.comment_count ?? 0);
    const negativeCount = Number(metricsRow?.negative_count ?? 0);
    const totalContentCount = postCount + commentCount;
    const highRiskContents = await this.loadOverviewContents(highRiskResult[0]);

    return {
      metrics: {
        postCount,
        commentCount,
        negativeCount,
        negativeRatio: totalContentCount === 0 ? 0 : negativeCount / totalContentCount
      },
      sentimentTrend: completeSentimentTrend(trendResult[0].map((row) => ({
        bucket: String(row.bucket), positive: Number(row.positive), neutral: Number(row.neutral),
        negative: Number(row.negative), unknown: Number(row.unknown_count)
      })), requestedTrendBuckets),
      brandRanking: brandResult[0].map((row) => ({
        brandId: String(row.brand_id), brandName: String(row.brand_name),
        contentCount: Number(row.content_count), negativeCount: Number(row.negative_count)
      })),
      categoryRanking: categoryResult[0].map((row) => ({
        categoryId: String(row.category_id), categoryName: String(row.category_name), contentCount: Number(row.content_count)
      })),
      problemTypeRanking: problemTypeResult[0].map((row) => ({
        problemTypeId: String(row.problem_type_id), problemTypeName: String(row.problem_type_name),
        contentCount: Number(row.content_count)
      })),
      risingTopics: topicResult[0].map((row) => {
        const evidenceCount = Number(row.evidence_count);
        const previousEvidenceCount = row.previous_evidence_count === null || row.previous_evidence_count === undefined
          ? null
          : Number(row.previous_evidence_count);
        return {
          topicId: String(row.topic_id),
          topicName: String(row.topic_name),
          changeRatio: previousEvidenceCount === null || previousEvidenceCount === 0
            ? null
            : (evidenceCount - previousEvidenceCount) / previousEvidenceCount,
          evidenceCount,
          affectedPostCount: Number(row.affected_post_count ?? 0),
          commentCount: Number(row.comment_count ?? 0)
        };
      }),
      highRiskContents,
      collectionHealth,
      lastSuccessfulCollectionAt
    };
  }

  async getDataManagementSummary(): Promise<DataManagementSummary> {
    const [rows] = await this.pool.query<RowDataPacket[]>(`
      WITH ranked_analysis AS (
        SELECT ar.content_type, ar.post_id, ar.comment_id, ar.status, ar.updated_at,
               ROW_NUMBER() OVER (
                 PARTITION BY ar.content_type, COALESCE(ar.post_id, ar.comment_id)
                 ORDER BY ar.updated_at DESC, ar.id DESC
               ) AS status_rank
        FROM analysis_records ar
      ), latest_analysis_status AS (
        SELECT * FROM ranked_analysis WHERE status_rank = 1
      )
      SELECT
        (SELECT COUNT(*) FROM posts) AS total_posts,
        (SELECT COUNT(*) FROM comments) AS total_comments,
        (SELECT COUNT(DISTINCT post_id) FROM analysis_records
          WHERE content_type = 'post' AND status = 'success' AND post_id IS NOT NULL) AS ai_classified_posts,
        (SELECT COUNT(DISTINCT comment_id) FROM analysis_records
          WHERE content_type = 'comment' AND status = 'success' AND comment_id IS NOT NULL) AS ai_classified_comments,
        (SELECT COUNT(*) FROM latest_analysis_status WHERE status = 'running') AS analysis_running_count,
        (SELECT COUNT(*) FROM latest_analysis_status WHERE status = 'failed') AS analysis_failed_count,
        (SELECT COUNT(*) FROM manual_corrections WHERE deleted_at IS NULL) AS manual_correction_count,
        (SELECT MAX(completed_at) FROM analysis_records WHERE status = 'success') AS last_analysis_at
    `);
    const row = rows[0] ?? ({} as RowDataPacket);
    return {
      totalPosts: Number(row.total_posts ?? 0),
      totalComments: Number(row.total_comments ?? 0),
      aiClassifiedPosts: Number(row.ai_classified_posts ?? 0),
      aiClassifiedComments: Number(row.ai_classified_comments ?? 0),
      analysisRunningCount: Number(row.analysis_running_count ?? 0),
      analysisFailedCount: Number(row.analysis_failed_count ?? 0),
      manualCorrectionCount: Number(row.manual_correction_count ?? 0),
      lastAnalysisAt: iso(row.last_analysis_at ?? null)
    };
  }

  private async loadOverviewContents(targets: RowDataPacket[]): Promise<ContentSummary[]> {
    if (targets.length === 0) return [];
    const postIds = targets.filter((row) => row.content_type === "POST").map((row) => String(row.content_id));
    const commentIds = targets.filter((row) => row.content_type === "COMMENT").map((row) => String(row.content_id));
    const summaries = new Map<string, ContentSummary>();
    if (postIds.length) {
      const placeholders = postIds.map(() => "?").join(",");
      const [rows] = await this.pool.query<RowDataPacket[]>(
        `SELECT p.id, p.source_url, p.title, p.description, p.author_nickname, p.published_at,
                p.first_collected_at, p.last_collected_at,
                s.liked_count, s.collected_count, s.comment_count,
                GROUP_CONCAT(DISTINCT bpm.brand_id ORDER BY bpm.brand_id) AS brand_ids
         FROM posts p
         LEFT JOIN post_interaction_snapshots s ON s.id = (
           SELECT ps.id FROM post_interaction_snapshots ps WHERE ps.post_id = p.id ORDER BY ps.observed_at DESC, ps.id DESC LIMIT 1
         )
         LEFT JOIN brand_post_matches bpm ON bpm.post_id = p.id
         WHERE p.id IN (${placeholders})
         GROUP BY p.id, p.source_url, p.title, p.description, p.author_nickname, p.published_at,
                  p.first_collected_at, p.last_collected_at, s.liked_count, s.collected_count, s.comment_count`,
        postIds
      );
      const analyses = await this.loadResolvedAnalyses("POST", postIds);
      for (const row of rows) summaries.set(`POST:${row.id}`, this.mapPost(row, analyses.get(String(row.id))?.effective));
    }
    if (commentIds.length) {
      const placeholders = commentIds.map(() => "?").join(",");
      const [rows] = await this.pool.query<RowDataPacket[]>(
        `SELECT c.id, c.post_id, c.content, c.author_nickname, c.published_text,
                c.first_collected_at, c.last_collected_at, p.source_url,
                s.liked_count, GROUP_CONCAT(DISTINCT bpm.brand_id ORDER BY bpm.brand_id) AS brand_ids
         FROM comments c
         INNER JOIN posts p ON p.id = c.post_id
         LEFT JOIN comment_interaction_snapshots s ON s.id = (
           SELECT cs.id FROM comment_interaction_snapshots cs WHERE cs.comment_id = c.id ORDER BY cs.observed_at DESC, cs.id DESC LIMIT 1
         )
         LEFT JOIN brand_post_matches bpm ON bpm.post_id = p.id
         WHERE c.id IN (${placeholders})
         GROUP BY c.id, c.post_id, c.content, c.author_nickname, c.published_text,
                  c.first_collected_at, c.last_collected_at, p.source_url, s.liked_count`,
        commentIds
      );
      const analyses = await this.loadResolvedAnalyses("COMMENT", commentIds);
      for (const row of rows) summaries.set(`COMMENT:${row.id}`, this.mapComment(row, analyses.get(String(row.id))?.effective));
    }
    return targets.flatMap((row) => summaries.get(`${row.content_type}:${row.content_id}`) ?? []);
  }

  async listTopics(): Promise<never> { dataNotReady(); }
  async listKeywords(): Promise<never> { dataNotReady(); }
  async listTopicEvidence(
    topicId: string,
    options: ListOptions
  ): Promise<Page<ContentDetail["context"][number]>> {
    const [topicRows] = await this.pool.query<RowDataPacket[]>(
      "SELECT id FROM classification_items WHERE id = ? AND classification_type = 'topic' LIMIT 1",
      [topicId]
    );
    if (topicRows.length === 0) {
      throw new RepositoryError("NOT_FOUND", 404, false, "原因主题不存在。");
    }

    const scope = overviewScope(options);
    const topicMembership = `(
      (JSON_CONTAINS_PATH(ec.patch_json, 'one', '$.topicIds')
        AND JSON_CONTAINS(JSON_EXTRACT(ec.patch_json, '$.topicIds'), JSON_QUOTE(?)))
      OR
      (NOT JSON_CONTAINS_PATH(COALESCE(ec.patch_json, JSON_OBJECT()), 'one', '$.topicIds')
        AND EXISTS (
          SELECT 1 FROM analysis_topics relation
          WHERE relation.analysis_record_id = ec.analysis_record_id
            AND relation.classification_item_id = ?
        ))
    )`;
    const typeClause = options.contentType ? "AND ec.content_type = ?" : "";
    const filterParams = [topicId, topicId, ...(options.contentType ? [options.contentType] : [])];
    const queryPrefix = `${scope.cte}\n`;
    const [countRows] = await this.pool.query<CountRow[]>(
      `${queryPrefix}SELECT COUNT(*) AS total FROM effective_content ec
       WHERE ${topicMembership}
         AND LOWER(COALESCE(ec.sentiment, _ascii'unknown' COLLATE ascii_bin)) = _ascii'negative' COLLATE ascii_bin
         ${typeClause}`,
      [...scope.params, ...filterParams]
    );
    const offset = (options.page - 1) * options.pageSize;
    const [targets] = await this.pool.query<RowDataPacket[]>(
      `${queryPrefix}SELECT ec.content_type, ec.content_id
       FROM effective_content ec
       WHERE ${topicMembership}
         AND LOWER(COALESCE(ec.sentiment, _ascii'unknown' COLLATE ascii_bin)) = _ascii'negative' COLLATE ascii_bin
         ${typeClause}
       ORDER BY ec.last_collected_at ${options.sortOrder}, ec.content_type, ec.content_id ${options.sortOrder}
       LIMIT ? OFFSET ?`,
      [...scope.params, ...filterParams, options.pageSize, offset]
    );
    const summaries = await this.loadOverviewContents(targets);
    const items = summaries.map((item) => ({
      contentType: item.contentType,
      contentId: item.id,
      evidenceOrigin: item.evidenceOrigin,
      excerpt: item.excerpt,
      authorDisplayName: item.authorDisplayName,
      publishedAt: item.publishedAt,
      likedCount: item.likedCount,
      sourceUrl: item.sourceUrl,
      canOpenOriginal: item.canOpenOriginal
    }));
    return page(items, Number(countRows[0]?.total ?? 0), options);
  }
  async listClassifications(options: ListOptions): Promise<Page<ClassificationItem>> {
    const offset = (options.page - 1) * options.pageSize;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.classificationType) {
      clauses.push("classification_type = ?");
      params.push(options.classificationType.toLowerCase());
    }
    if (options.isEnabled !== undefined) {
      clauses.push("status = ?");
      params.push(options.isEnabled ? "enabled" : "disabled");
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const [countRows] = await this.pool.query<CountRow[]>(
      `SELECT COUNT(*) AS total FROM classification_items ${where}`, params
    );
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, classification_type, item_code, display_name, description, status, sort_order, version
       FROM classification_items ${where}
       ORDER BY classification_type, sort_order, id LIMIT ? OFFSET ?`,
      [...params, options.pageSize, offset]
    );
    return page(rows.map((row) => ({
      id: String(row.id), classificationType: upper(row.classification_type), code: String(row.item_code),
      displayName: String(row.display_name), description: row.description ?? null,
      isEnabled: row.status === "enabled", sortOrder: Number(row.sort_order), version: Number(row.version)
    })), Number(countRows[0]?.total ?? 0), options);
  }

  async listContents(options: ListOptions): Promise<Page<ContentSummary>> {
    if (options.contentType === "COMMENT") return this.listComments(options);
    if (options.contentType === "POST") return this.listPosts(options);
    throw new RepositoryError("VALIDATION_ERROR", 400, false, "LIVE模式查询内容时必须指定contentType，以保证分页稳定。" );
  }

  private async listPosts(options: ListOptions): Promise<Page<ContentSummary>> {
    const offset = (options.page - 1) * options.pageSize;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.keyword) {
      const keyword = `%${options.keyword}%`;
      clauses.push("(p.title LIKE ? OR p.description LIKE ?)");
      params.push(keyword, keyword);
    }
    if (options.from) { clauses.push("p.published_at >= ?"); params.push(options.from); }
    if (options.to) { clauses.push("p.published_at <= ?"); params.push(options.to); }
    if (options.brandIds) {
      const placeholders = options.brandIds.map(() => "?").join(",");
      clauses.push(`EXISTS (SELECT 1 FROM brand_post_matches filter_bpm WHERE filter_bpm.post_id = p.id AND filter_bpm.brand_id IN (${placeholders}))`);
      params.push(...options.brandIds);
    }
    appendEffectiveAnalysisFilters("p", options, clauses, params);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const [countRows] = await this.pool.query<CountRow[]>(`SELECT COUNT(*) AS total FROM posts p ${where}`, params);
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT p.id, p.source_url, p.title, p.description, p.author_nickname, p.published_at,
              p.first_collected_at, p.last_collected_at,
              s.liked_count, s.collected_count, s.comment_count,
              GROUP_CONCAT(DISTINCT bpm.brand_id ORDER BY bpm.brand_id) AS brand_ids
       FROM posts p
       LEFT JOIN post_interaction_snapshots s ON s.id = (
         SELECT ps.id FROM post_interaction_snapshots ps WHERE ps.post_id = p.id ORDER BY ps.observed_at DESC, ps.id DESC LIMIT 1
       )
       LEFT JOIN brand_post_matches bpm ON bpm.post_id = p.id
       ${where}
       GROUP BY p.id, p.source_url, p.title, p.description, p.author_nickname, p.published_at,
                p.first_collected_at, p.last_collected_at, s.liked_count, s.collected_count, s.comment_count
       ORDER BY p.last_collected_at ${options.sortOrder}, p.id ${options.sortOrder}
       LIMIT ? OFFSET ?`,
      [...params, options.pageSize, offset]
    );
    const analyses = await this.loadResolvedAnalyses("POST", rows.map((row) => String(row.id)));
    const items = rows.map((row) => this.mapPost(row, analyses.get(String(row.id))?.effective));
    return page(items, Number(countRows[0]?.total ?? 0), options);
  }

  private async listComments(options: ListOptions): Promise<Page<ContentSummary>> {
    if (options.from || options.to) {
      throw new RepositoryError("VALIDATION_ERROR", 400, false, "评论采集数据没有可验证的发布时间，不能应用from或to筛选。");
    }
    const offset = (options.page - 1) * options.pageSize;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.keyword) { clauses.push("c.content LIKE ?"); params.push(`%${options.keyword}%`); }
    if (options.brandIds) {
      const placeholders = options.brandIds.map(() => "?").join(",");
      clauses.push(`EXISTS (SELECT 1 FROM brand_post_matches filter_bpm WHERE filter_bpm.post_id = c.post_id AND filter_bpm.brand_id IN (${placeholders}))`);
      params.push(...options.brandIds);
    }
    appendEffectiveAnalysisFilters("c", options, clauses, params);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const [countRows] = await this.pool.query<CountRow[]>(`SELECT COUNT(*) AS total FROM comments c ${where}`, params);
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT c.id, c.post_id, c.content, c.author_nickname, c.published_text,
              c.first_collected_at, c.last_collected_at, p.source_url,
              s.liked_count, GROUP_CONCAT(DISTINCT bpm.brand_id ORDER BY bpm.brand_id) AS brand_ids
       FROM comments c
       INNER JOIN posts p ON p.id = c.post_id
       LEFT JOIN comment_interaction_snapshots s ON s.id = (
         SELECT cs.id FROM comment_interaction_snapshots cs WHERE cs.comment_id = c.id ORDER BY cs.observed_at DESC, cs.id DESC LIMIT 1
       )
       LEFT JOIN brand_post_matches bpm ON bpm.post_id = p.id
       ${where}
       GROUP BY c.id, c.post_id, c.content, c.author_nickname, c.published_text,
                c.first_collected_at, c.last_collected_at, p.source_url, s.liked_count
       ORDER BY c.last_collected_at ${options.sortOrder}, c.id ${options.sortOrder}
       LIMIT ? OFFSET ?`,
      [...params, options.pageSize, offset]
    );
    const analyses = await this.loadResolvedAnalyses("COMMENT", rows.map((row) => String(row.id)));
    const items = rows.map((row) => this.mapComment(row, analyses.get(String(row.id))?.effective));
    return page(items, Number(countRows[0]?.total ?? 0), options);
  }

  async getContent(contentType: "POST" | "COMMENT", contentId: string): Promise<ContentDetail> {
    const options: ListOptions = { page: 1, pageSize: 10, sortOrder: "DESC" };
    const table = contentType === "POST" ? "posts" : "comments";
    const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT id FROM ${table} WHERE id = ? LIMIT 1`, [contentId]);
    if (rows.length === 0) throw new RepositoryError("NOT_FOUND", 404, false, "内容不存在。");

    const [detailRows] = contentType === "POST"
      ? await this.pool.query<RowDataPacket[]>(
          `SELECT p.id, p.source_url, p.title, p.description, p.author_nickname, p.published_at,
                  p.first_collected_at, p.last_collected_at, s.liked_count, s.collected_count, s.comment_count,
                  GROUP_CONCAT(DISTINCT bpm.brand_id ORDER BY bpm.brand_id) AS brand_ids
           FROM posts p
           LEFT JOIN post_interaction_snapshots s ON s.id = (SELECT ps.id FROM post_interaction_snapshots ps WHERE ps.post_id = p.id ORDER BY ps.observed_at DESC, ps.id DESC LIMIT 1)
           LEFT JOIN brand_post_matches bpm ON bpm.post_id = p.id WHERE p.id = ?
           GROUP BY p.id, p.source_url, p.title, p.description, p.author_nickname, p.published_at,
                    p.first_collected_at, p.last_collected_at,
                    s.liked_count, s.collected_count, s.comment_count`, [contentId])
      : await this.pool.query<RowDataPacket[]>(
          `SELECT c.id, c.post_id, c.parent_comment_id, c.content, c.author_nickname, c.published_text,
                  c.first_collected_at, c.last_collected_at, p.source_url, s.liked_count,
                  p.title AS post_title, p.description AS post_description, p.author_nickname AS post_author,
                  p.published_at AS post_published_at, ps.liked_count AS post_liked_count,
                  parent.content AS parent_content, parent.author_nickname AS parent_author,
                  pcs.liked_count AS parent_liked_count,
                  GROUP_CONCAT(DISTINCT bpm.brand_id ORDER BY bpm.brand_id) AS brand_ids
           FROM comments c INNER JOIN posts p ON p.id = c.post_id
           LEFT JOIN comments parent ON parent.id = c.parent_comment_id
           LEFT JOIN comment_interaction_snapshots s ON s.id = (SELECT cs.id FROM comment_interaction_snapshots cs WHERE cs.comment_id = c.id ORDER BY cs.observed_at DESC, cs.id DESC LIMIT 1)
           LEFT JOIN post_interaction_snapshots ps ON ps.id = (SELECT psi.id FROM post_interaction_snapshots psi WHERE psi.post_id = p.id ORDER BY psi.observed_at DESC, psi.id DESC LIMIT 1)
           LEFT JOIN comment_interaction_snapshots pcs ON pcs.id = (SELECT pcsi.id FROM comment_interaction_snapshots pcsi WHERE pcsi.comment_id = parent.id ORDER BY pcsi.observed_at DESC, pcsi.id DESC LIMIT 1)
           LEFT JOIN brand_post_matches bpm ON bpm.post_id = p.id WHERE c.id = ?
           GROUP BY c.id, c.post_id, c.parent_comment_id, c.content, c.author_nickname, c.published_text,
                    c.first_collected_at, c.last_collected_at, p.source_url, s.liked_count,
                    p.title, p.description, p.author_nickname, p.published_at, ps.liked_count,
                    parent.content, parent.author_nickname, pcs.liked_count`, [contentId]);
    const detail = detailRows[0];
    if (!detail) throw new RepositoryError("NOT_FOUND", 404, false, "内容不存在。");
    const analysis = await this.loadResolvedAnalysis(contentType, contentId);
    const summary = contentType === "POST" ? this.mapPost(detail, analysis.effective) : this.mapComment(detail, analysis.effective);
    const context: ContentDetail["context"] = [];
    if (contentType === "COMMENT") {
      const sourceUrl = xiaohongshuSourceUrl(detail.source_url);
      context.push({
        contentType: "POST", contentId: String(detail.post_id), evidenceOrigin: "ORIGINAL",
        excerpt: [detail.post_title, detail.post_description].filter((value) => typeof value === "string" && value.length > 0)
          .join("\n").slice(0, 500) || null,
        authorDisplayName: detail.post_author ?? null, publishedAt: iso(detail.post_published_at),
        likedCount: detail.post_liked_count === null ? null : Number(detail.post_liked_count),
        sourceUrl, canOpenOriginal: true
      });
      if (detail.parent_comment_id !== null && detail.parent_comment_id !== undefined) {
        context.push({
          contentType: "COMMENT", contentId: String(detail.parent_comment_id), evidenceOrigin: "ORIGINAL",
          excerpt: detail.parent_content?.slice(0, 500) ?? null,
          authorDisplayName: detail.parent_author ?? null, publishedAt: null,
          likedCount: detail.parent_liked_count === null ? null : Number(detail.parent_liked_count),
          sourceUrl, canOpenOriginal: true
        });
      }
    }
    return {
      ...summary,
      fullText: contentType === "POST" ? detail.description ?? null : detail.content ?? null,
      parentCommentId: detail.parent_comment_id === null || detail.parent_comment_id === undefined ? null : String(detail.parent_comment_id),
      context,
      modelAnalysis: analysis.model
    };
  }

  private mapPost(row: RowDataPacket, analysis?: EffectiveAnalysis): ContentSummary {
    const sourceUrl = xiaohongshuSourceUrl(row.source_url);
    return {
      id: String(row.id), contentType: "POST", postId: String(row.id), title: row.title ?? null,
      excerpt: row.description?.slice(0, 240) ?? null, authorDisplayName: row.author_nickname ?? null,
      publishedAt: iso(row.published_at), likedCount: row.liked_count === null ? null : Number(row.liked_count),
      collectedCount: row.collected_count === null ? null : Number(row.collected_count),
      commentCount: row.comment_count === null ? null : Number(row.comment_count), sourceUrl,
      brandIds: row.brand_ids ? String(row.brand_ids).split(",") : [], effectiveAnalysis: analysis ?? unavailableAnalysis(),
      evidenceOrigin: "ORIGINAL", canOpenOriginal: true, firstCollectedAt: iso(row.first_collected_at),
      lastCollectedAt: iso(row.last_collected_at)
    };
  }

  private mapComment(row: RowDataPacket, analysis?: EffectiveAnalysis): ContentSummary {
    const sourceUrl = xiaohongshuSourceUrl(row.source_url);
    return {
      id: String(row.id), contentType: "COMMENT", postId: String(row.post_id), title: null,
      excerpt: row.content?.slice(0, 240) ?? null, authorDisplayName: row.author_nickname ?? null,
      publishedAt: null, likedCount: row.liked_count === null ? null : Number(row.liked_count),
      collectedCount: null, commentCount: null, sourceUrl,
      brandIds: row.brand_ids ? String(row.brand_ids).split(",") : [], effectiveAnalysis: analysis ?? unavailableAnalysis(),
      evidenceOrigin: "ORIGINAL", canOpenOriginal: true, firstCollectedAt: iso(row.first_collected_at),
      lastCollectedAt: iso(row.last_collected_at)
    };
  }

  private async loadResolvedAnalyses(
    contentType: "POST" | "COMMENT",
    contentIds: string[]
  ): Promise<Map<string, ResolvedAnalysis>> {
    const result = new Map<string, ResolvedAnalysis>();
    if (contentIds.length === 0) return result;
    const targetColumn = contentType === "POST" ? "post_id" : "comment_id";
    const placeholders = contentIds.map(() => "?").join(",");
    const [modelRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT ar.*,
              (SELECT GROUP_CONCAT(apt.classification_item_id ORDER BY apt.classification_item_id)
               FROM analysis_problem_types apt WHERE apt.analysis_record_id = ar.id) AS problem_type_ids,
              (SELECT GROUP_CONCAT(atp.classification_item_id ORDER BY atp.classification_item_id)
               FROM analysis_topics atp WHERE atp.analysis_record_id = ar.id) AS topic_ids
       FROM analysis_records ar
       WHERE ar.status = 'success' AND ar.${targetColumn} IN (${placeholders})
         AND ar.id = (SELECT ar2.id FROM analysis_records ar2
                      WHERE ar2.${targetColumn} = ar.${targetColumn} AND ar2.status = 'success'
                      ORDER BY ar2.completed_at DESC, ar2.id DESC LIMIT 1)`,
      contentIds
    );
    for (const row of modelRows) {
      const key = String(row[targetColumn]);
      const model = modelAnalysis(row);
      result.set(key, { effective: model, model });
    }
    const [correctionRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM manual_corrections WHERE ${targetColumn} IN (${placeholders})`, contentIds
    );
    for (const row of correctionRows) {
      const key = String(row[targetColumn]);
      const current = result.get(key) ?? { effective: unavailableAnalysis(), model: null };
      result.set(key, { ...current, effective: applyCorrection(current.effective, row) });
    }
    return result;
  }

  private async loadResolvedAnalysis(contentType: "POST" | "COMMENT", contentId: string): Promise<ResolvedAnalysis> {
    return (await this.loadResolvedAnalyses(contentType, [contentId])).get(contentId)
      ?? { effective: unavailableAnalysis(), model: null };
  }

  async listBrands(options: ListOptions): Promise<Page<Brand>> {
    const offset = (options.page - 1) * options.pageSize;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.keyword) { clauses.push("b.brand_name LIKE ?"); params.push(`%${options.keyword}%`); }
    if (options.status) { clauses.push("b.status = ?"); params.push(options.status.toLowerCase()); }
    if (options.brandIds) {
      clauses.push(`b.id IN (${options.brandIds.map(() => "?").join(",")})`);
      params.push(...options.brandIds);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const [countRows] = await this.pool.query<CountRow[]>(`SELECT COUNT(*) AS total FROM brands b ${where}`, params);
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT b.id, b.brand_name, b.status, b.created_at, b.updated_at,
              (SELECT MAX(t.finished_at) FROM collection_tasks t WHERE t.brand_id = b.id AND t.status IN ('success', 'partial_success')) AS last_success,
              (SELECT t.status FROM collection_tasks t WHERE t.brand_id = b.id ORDER BY t.created_at DESC, t.id DESC LIMIT 1) AS latest_status
       FROM brands b ${where} ORDER BY b.updated_at ${options.sortOrder}, b.id ${options.sortOrder} LIMIT ? OFFSET ?`,
      [...params, options.pageSize, offset]
    );
    const ids = rows.map((row) => row.id);
    const termMap = new Map<string, Brand["searchTerms"]>();
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(",");
      const [terms] = await this.pool.query<RowDataPacket[]>(
        `SELECT id, brand_id, term_type, term_value, status FROM brand_search_terms WHERE brand_id IN (${placeholders}) ORDER BY id`, ids);
      for (const term of terms) {
        const key = String(term.brand_id);
        const current = termMap.get(key) ?? [];
        current.push({ id: String(term.id), type: upper(term.term_type), value: term.term_value, status: upper(term.status) });
        termMap.set(key, current);
      }
    }
    const items: Brand[] = rows.map((row) => ({
      id: String(row.id), name: String(row.brand_name), status: upper(row.status), searchTerms: termMap.get(String(row.id)) ?? [],
      lastSuccessfulCollectionAt: iso(row.last_success),
      latestTaskStatus: row.latest_status ? upper<NonNullable<Brand["latestTaskStatus"]>>(String(row.latest_status)) : null,
      version: Math.max(1, new Date(row.updated_at).getTime()), createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!
    }));
    return page(items, Number(countRows[0]?.total ?? 0), options);
  }

  async createBrand(_input: BrandCreateInput): Promise<Brand> { return notImplemented(); }
  async updateBrand(_brandId: string, _version: number, _input: OptionalPatch<BrandCreateInput>): Promise<Brand> { return notImplemented(); }

  async listCollectionRuns(options: ListOptions): Promise<CollectionRunPage> {
    const offset = (options.page - 1) * options.pageSize;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.status) { clauses.push("status = ?"); params.push(options.status.toLowerCase()); }
    if (options.statuses) {
      clauses.push(`status IN (${options.statuses.map(() => "?").join(",")})`);
      params.push(...options.statuses.map((status) => status.toLowerCase()));
    }
    if (options.brandIds) {
      clauses.push(`brand_id IN (${options.brandIds.map(() => "?").join(",")})`);
      params.push(...options.brandIds);
    }
    if (options.from) { clauses.push("created_at >= ?"); params.push(options.from); }
    if (options.to) { clauses.push("created_at <= ?"); params.push(options.to); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const [countRows] = await this.pool.query<CountRow[]>(`SELECT COUNT(*) AS total FROM collection_tasks ${where}`, params);
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, brand_id, trigger_type, keyword, requested_note_limit, status, started_at, finished_at,
              succeeded_post_count, failed_post_count, fetched_post_count, fetched_comment_count,
              stored_post_count, stored_comment_count, skipped_no_comment_post_count, failed_count,
              error_type, error_summary, retry_of_task_id
       FROM collection_tasks ${where} ORDER BY created_at ${options.sortOrder}, id ${options.sortOrder} LIMIT ? OFFSET ?`,
      [...params, options.pageSize, offset]
    );
    const items = rows.map(collectionTaskSummary);
    const [statusRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT status, finished_at, error_type
       FROM collection_tasks
       WHERE status IN ('success', 'partial_success', 'failed')
       ORDER BY COALESCE(finished_at, created_at) DESC, id DESC`
    );
    const lastSuccessfulCollectionAt = iso(statusRows.find((row) =>
      row.status === "success" || row.status === "partial_success"
    )?.finished_at ?? null);
    let consecutiveFailureCount = 0;
    for (const row of statusRows) {
      if (row.status !== "failed") break;
      consecutiveFailureCount += 1;
    }
    return {
      ...page(items, Number(countRows[0]?.total ?? 0), options),
      lastSuccessfulCollectionAt,
      consecutiveFailureCount,
      volumeAnomaly: statusRows.some((row) => row.error_type === "volume_anomaly")
    };
  }

  private credentialRepository(): ServiceCredentialRepository {
    try {
      return new ServiceCredentialRepository(this.pool, createCredentialCrypto());
    } catch {
      throw new RepositoryError("DEPENDENCY_UNAVAILABLE", 503, false, "凭证加密服务暂时不可用。");
    }
  }

  async listServiceCredentials(): Promise<ServiceCredentialSummary[]> {
    try {
      return await this.credentialRepository().listSummaries();
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError("DEPENDENCY_UNAVAILABLE", 503, false, "凭证服务暂时不可用。");
    }
  }

  async saveServiceCredential(kind: CredentialKind, secret: string): Promise<ServiceCredentialSummary> {
    try {
      return await this.credentialRepository().upsert(kind, secret);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError("DEPENDENCY_UNAVAILABLE", 503, false, "凭证服务暂时不可用。");
    }
  }

  async deleteServiceCredential(kind: CredentialKind): Promise<ServiceCredentialSummary> {
    if (kind === "JUSTONEAPI") {
      const [rows] = await this.pool.query<RowDataPacket[]>(
        "SELECT id FROM collection_tasks WHERE status IN ('queued', 'running', 'stopping') LIMIT 1"
      );
      if (rows.length > 0) {
        throw new RepositoryError("VALIDATION_ERROR", 422, false, "有采集任务正在运行，暂时不能删除采集凭证。");
      }
    } else {
      const [rows] = await this.pool.query<RowDataPacket[]>(
        "SELECT IS_USED_LOCK(?) AS lockOwner",
        ["readtrace:content-analysis"]
      );
      if (rows[0]?.lockOwner !== null && rows[0]?.lockOwner !== undefined) {
        throw new RepositoryError("VALIDATION_ERROR", 422, false, "有分析任务正在运行，暂时不能删除分析凭证。");
      }
    }
    try {
      const credentials = this.credentialRepository();
      await credentials.delete(kind);
      return await credentials.getSummary(kind);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError("DEPENDENCY_UNAVAILABLE", 503, false, "凭证服务暂时不可用。");
    }
  }

  async startCollection(input: CollectionRunCreateInput): Promise<CollectionTaskSummary> {
    if (!/^\d+$/.test(input.brandId)) throw new RepositoryError("VALIDATION_ERROR", 422, false, "品牌编号无效。");
    const token = await this.credentialRepository().getSecret("JUSTONEAPI").catch(() => {
      throw new RepositoryError("DEPENDENCY_UNAVAILABLE", 503, false, "采集凭证暂时无法读取。");
    });
    if (!token) throw new RepositoryError("VALIDATION_ERROR", 422, false, "请先配置JustOneAPI Token。");
    const tasks = new CollectionTaskRepository(this.pool);
    let created;
    try {
      created = await tasks.createApiTask({
        brandId: Number(input.brandId),
        keyword: input.keyword,
        noteLimit: input.noteLimit
      });
    } catch (error) {
      if (error instanceof PersistenceError && error.message === "collection_already_running") {
        throw new RepositoryError("COLLECTION_ALREADY_RUNNING", 409, false, "该品牌已有采集任务正在执行。");
      }
      if (error instanceof PersistenceError && error.message === "brand_not_found") {
        throw new RepositoryError("NOT_FOUND", 404, false, "品牌不存在。");
      }
      if (error instanceof PersistenceError && error.message === "brand_not_enabled") {
        throw new RepositoryError("VALIDATION_ERROR", 422, false, "只有已启用的品牌可以开始采集。");
      }
      throw new RepositoryError("DEPENDENCY_UNAVAILABLE", 503, true, "采集任务暂时无法创建。");
    }
    void runCollectionTask({ pool: this.pool, task: created, justOneApiToken: token }).catch(async () => {
      await tasks.finishApiTask(created.taskId, "failed", "collection_runner_failed").catch(() => undefined);
    });
    return await this.getCollectionTask(String(created.taskId));
  }

  async stopCollection(taskId: string): Promise<CollectionTaskSummary> {
    if (!/^\d+$/.test(taskId)) throw new RepositoryError("NOT_FOUND", 404, false, "采集任务不存在。");
    try {
      await new CollectionTaskRepository(this.pool).requestStop(Number(taskId));
    } catch (error) {
      if (error instanceof PersistenceError && error.message === "task_not_found") {
        throw new RepositoryError("NOT_FOUND", 404, false, "采集任务不存在。");
      }
      if (error instanceof PersistenceError && error.message === "task_not_stoppable") {
        throw new RepositoryError("VALIDATION_ERROR", 422, false, "只有正在执行的采集任务可以停止。");
      }
      throw new RepositoryError("DEPENDENCY_UNAVAILABLE", 503, true, "暂时无法停止采集任务。");
    }
    return await this.getCollectionTask(taskId);
  }

  private async getCollectionTask(taskId: string): Promise<CollectionTaskSummary> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, brand_id, trigger_type, keyword, requested_note_limit, status, started_at, finished_at,
              succeeded_post_count, failed_post_count, fetched_post_count, fetched_comment_count,
              stored_post_count, stored_comment_count, skipped_no_comment_post_count, failed_count,
              error_type, error_summary, retry_of_task_id
       FROM collection_tasks WHERE id = ? LIMIT 1`,
      [taskId]
    );
    const row = rows[0];
    if (!row) throw new RepositoryError("NOT_FOUND", 404, false, "采集任务不存在。");
    return collectionTaskSummary(row);
  }

  async startManualCollection(_brandId: string): Promise<CollectionTaskSummary> { return dataNotReady(); }
  async retryCollectionRun(_taskId: string): Promise<CollectionTaskSummary> { return dataNotReady(); }

  async updateCorrection(
    contentType: "POST" | "COMMENT",
    contentId: string,
    version: number,
    input: OptionalPatch<EffectiveAnalysis>
  ): Promise<EffectiveAnalysis> {
    const table = contentType === "POST" ? "posts" : "comments";
    const targetColumn = contentType === "POST" ? "post_id" : "comment_id";
    const [targetRows] = await this.pool.query<RowDataPacket[]>(`SELECT id FROM ${table} WHERE id = ? LIMIT 1`, [contentId]);
    if (targetRows.length === 0) throw new RepositoryError("NOT_FOUND", 404, false, "内容不存在。");
    const normalizedInput: OptionalPatch<EffectiveAnalysis> = {
      ...input,
      ...(input.problemTypeIds ? { problemTypeIds: [...new Set(input.problemTypeIds)] } : {}),
      ...(input.topicIds ? { topicIds: [...new Set(input.topicIds)] } : {})
    };
    await this.validateCorrectionTaxonomy(normalizedInput);
    const current = await this.loadResolvedAnalysis(contentType, contentId);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT id, patch_json, version, deleted_at FROM manual_corrections WHERE ${targetColumn} = ? FOR UPDATE`,
        [contentId]
      );
      const existing = rows[0];
      const currentVersion = existing ? Number(existing.version) : current.effective.version;
      if (currentVersion !== version) {
        throw new RepositoryError("VERSION_CONFLICT", 409, false, "分析结果已经变化，请重新加载。");
      }
      const previousPatch = existing && existing.deleted_at === null ? jsonObject(existing.patch_json) : {};
      const patch = {
        ...previousPatch,
        ...Object.fromEntries(Object.entries(normalizedInput).filter(([, value]) => value !== undefined))
      };
      if (existing) {
        await connection.execute(
          `UPDATE manual_corrections SET patch_json = ?, version = ?, corrected_at = CURRENT_TIMESTAMP(3), deleted_at = NULL
           WHERE id = ?`,
          [JSON.stringify(patch), version + 1, existing.id]
        );
      } else {
        await connection.execute(
          `INSERT INTO manual_corrections (content_type, post_id, comment_id, patch_json, version)
           VALUES (?, ?, ?, ?, ?)`,
          [contentType.toLowerCase(), contentType === "POST" ? contentId : null,
            contentType === "COMMENT" ? contentId : null, JSON.stringify(patch), version + 1]
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      if (error instanceof RepositoryError) throw error;
      if (error && typeof error === "object" && "code" in error && error.code === "ER_DUP_ENTRY") {
        throw new RepositoryError("VERSION_CONFLICT", 409, false, "分析结果已经变化，请重新加载。");
      }
      throw error;
    } finally {
      connection.release();
    }
    return (await this.loadResolvedAnalysis(contentType, contentId)).effective;
  }

  private async validateCorrectionTaxonomy(input: OptionalPatch<EffectiveAnalysis>): Promise<void> {
    const typedIds: Array<{ type: string; ids: string[] }> = [];
    if (input.categoryId) typedIds.push({ type: "category", ids: [input.categoryId] });
    if (input.problemTypeIds) typedIds.push({ type: "problem_type", ids: [...new Set(input.problemTypeIds)] });
    if (input.topicIds) typedIds.push({ type: "topic", ids: [...new Set(input.topicIds)] });
    for (const group of typedIds) {
      if (group.ids.length === 0) continue;
      const placeholders = group.ids.map(() => "?").join(",");
      const [rows] = await this.pool.query<RowDataPacket[]>(
        `SELECT id FROM classification_items
         WHERE classification_type = ? AND status = 'enabled' AND id IN (${placeholders})`,
        [group.type, ...group.ids]
      );
      if (rows.length !== group.ids.length) {
        throw new RepositoryError("VALIDATION_ERROR", 422, false, "人工修正引用了不存在或未启用的分类项。");
      }
    }
  }

  async deleteCorrection(contentType: "POST" | "COMMENT", contentId: string, version: number): Promise<EffectiveAnalysis> {
    const targetColumn = contentType === "POST" ? "post_id" : "comment_id";
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT id, version, deleted_at FROM manual_corrections WHERE ${targetColumn} = ? FOR UPDATE`,
        [contentId]
      );
      const correction = rows[0];
      if (!correction || correction.deleted_at !== null) {
        throw new RepositoryError("VALIDATION_ERROR", 422, false, "当前内容没有可以撤销的人工修正。");
      }
      if (Number(correction.version) !== version) {
        throw new RepositoryError("VERSION_CONFLICT", 409, false, "分析结果已经变化，请重新加载。");
      }
      await connection.execute(
        `UPDATE manual_corrections SET deleted_at = CURRENT_TIMESTAMP(3), version = ? WHERE id = ?`,
        [version + 1, correction.id]
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return (await this.loadResolvedAnalysis(contentType, contentId)).effective;
  }
}

export async function createMysqlRepository(): Promise<MysqlRepository> {
  let pool: Pool | undefined;
  try {
    const { createDatabaseContext } = await import("../../../../src/db/pool.js");
    const context = await createDatabaseContext();
    pool = context.pool;
    await pool.query("SELECT 1");
    return new MysqlRepository(pool);
  } catch {
    if (pool) await pool.end().catch(() => undefined);
    throw new RepositoryError("DEPENDENCY_UNAVAILABLE", 503, true, "数据库服务暂时不可用。");
  }
}
