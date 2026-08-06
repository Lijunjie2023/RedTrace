import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type {
  AnalysisCandidate,
  AnalysisContentType,
  AnalysisRequest,
  AnalysisResult,
  AnalysisStore,
  ClassificationItem,
  TokenUsage
} from "./types.js";

interface IdRow extends RowDataPacket { id: number }

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function splitNames(value: unknown): string[] {
  return typeof value === "string" && value.length > 0 ? value.split("\u001f") : [];
}

function target(request: AnalysisRequest): [number | null, number | null] {
  const id = Number(request.candidate.contentId);
  return request.candidate.contentType === "POST" ? [id, null] : [null, id];
}

export class MysqlAnalysisStore implements AnalysisStore {
  constructor(private readonly pool: Pool) {}

  async listEnabledClassifications(): Promise<ClassificationItem[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, classification_type, item_code, display_name, description, version
       FROM classification_items WHERE status = 'enabled'
       ORDER BY classification_type, sort_order, id`
    );
    return rows.map((row) => ({
      id: String(row.id),
      classificationType: String(row.classification_type).toUpperCase() as ClassificationItem["classificationType"],
      code: String(row.item_code),
      displayName: String(row.display_name),
      description: row.description === null ? null : String(row.description),
      version: Number(row.version)
    }));
  }

  async listCandidates(contentType: AnalysisContentType, limit: number, beforeId?: string): Promise<AnalysisCandidate[]> {
    return contentType === "POST" ? this.listPostCandidates(limit, beforeId) : this.listCommentCandidates(limit, beforeId);
  }

  private async listPostCandidates(limit: number, beforeId?: string): Promise<AnalysisCandidate[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT p.id, p.title, p.description, p.tags,
              GROUP_CONCAT(DISTINCT b.brand_name ORDER BY b.id SEPARATOR '\u001f') AS brand_names
       FROM posts p
       LEFT JOIN brand_post_matches bpm ON bpm.post_id = p.id
       LEFT JOIN brands b ON b.id = bpm.brand_id
       WHERE p.availability_status = 'available' AND (? IS NULL OR p.id < ?)
       GROUP BY p.id, p.title, p.description, p.tags
       ORDER BY p.id DESC LIMIT ?`,
      [beforeId ?? null, beforeId ?? null, limit]
    );
    return rows.map((row) => ({
      contentType: "POST", contentId: String(row.id), postId: String(row.id), title: row.title ?? null,
      text: row.description ?? null, tags: parseStringArray(row.tags), brandNames: splitNames(row.brand_names),
      postTitle: null, postContext: null, parentCommentText: null
    }));
  }

  private async listCommentCandidates(limit: number, beforeId?: string): Promise<AnalysisCandidate[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT c.id, c.post_id, c.content, p.title AS post_title, p.description AS post_context,
              parent.content AS parent_content,
              GROUP_CONCAT(DISTINCT b.brand_name ORDER BY b.id SEPARATOR '\u001f') AS brand_names
       FROM comments c
       INNER JOIN posts p ON p.id = c.post_id
       LEFT JOIN comments parent ON parent.id = c.parent_comment_id
       LEFT JOIN brand_post_matches bpm ON bpm.post_id = p.id
       LEFT JOIN brands b ON b.id = bpm.brand_id
       WHERE c.availability_status = 'available' AND (? IS NULL OR c.id < ?)
       GROUP BY c.id, c.post_id, c.content, p.title, p.description, parent.content
       ORDER BY c.id DESC LIMIT ?`,
      [beforeId ?? null, beforeId ?? null, limit]
    );
    return rows.map((row) => ({
      contentType: "COMMENT", contentId: String(row.id), postId: String(row.post_id), title: null,
      text: row.content ?? null, tags: [], brandNames: splitNames(row.brand_names),
      postTitle: row.post_title ?? null, postContext: row.post_context ?? null,
      parentCommentText: row.parent_content ?? null
    }));
  }

  async hasSuccessfulResult(idempotencyKey: string): Promise<boolean> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT id FROM analysis_records WHERE idempotency_key = ? AND status = 'success' LIMIT 1",
      [idempotencyKey]
    );
    return rows.length > 0;
  }

  async startAttempt(request: AnalysisRequest, ownerToken: string, leaseMs: number): Promise<boolean> {
    const [postId, commentId] = target(request);
    const leaseMicroseconds = leaseMs * 1_000;
    const [insertResult] = await this.pool.execute<ResultSetHeader>(
      `INSERT IGNORE INTO analysis_records (
         content_type, post_id, comment_id, input_digest, model_name, prompt_version,
         taxonomy_digest, idempotency_key, owner_token, lease_expires_at, status, attempt_count, started_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? MICROSECOND), 'running', 1, CURRENT_TIMESTAMP(3))`,
      [request.candidate.contentType.toLowerCase(), postId, commentId, request.inputDigest,
        request.modelName, request.promptVersion, request.taxonomyDigest, request.idempotencyKey,
        ownerToken, leaseMicroseconds]
    );
    if (insertResult.affectedRows === 1) return true;
    const [claimResult] = await this.pool.execute<ResultSetHeader>(
      `UPDATE analysis_records SET status = 'running', attempt_count = attempt_count + 1,
         owner_token = ?, lease_expires_at = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? MICROSECOND),
         started_at = CURRENT_TIMESTAMP(3), completed_at = NULL,
         error_code = NULL, error_summary = NULL
       WHERE idempotency_key = ? AND status <> 'success'
         AND (status = 'failed' OR lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP(3))`,
      [ownerToken, leaseMicroseconds, request.idempotencyKey]
    );
    return claimResult.affectedRows === 1;
  }

  async saveSuccess(request: AnalysisRequest, ownerToken: string, result: AnalysisResult, usage: TokenUsage): Promise<void> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const recordId = await this.lockRecord(connection, request.idempotencyKey, ownerToken);
      await connection.execute(
        `UPDATE analysis_records SET
           status = 'success', sentiment = ?, content_nature = ?, category_id = ?, product_series = ?,
           product_model = ?, user_stage = ?, risk_level = ?, confidence = ?, result_json = ?,
           prompt_tokens = ?, completion_tokens = ?, total_tokens = ?, error_code = NULL,
           error_summary = NULL, completed_at = CURRENT_TIMESTAMP(3), owner_token = NULL, lease_expires_at = NULL
         WHERE id = ? AND owner_token = ?`,
        [result.sentiment.toLowerCase(), result.contentNature, result.categoryId, result.productSeries,
          result.productModel, result.userStage, result.riskLevel.toLowerCase(), result.confidence.toLowerCase(),
          JSON.stringify(result), usage.promptTokens, usage.completionTokens, usage.totalTokens, recordId, ownerToken]
      );
      await connection.execute("DELETE FROM analysis_problem_types WHERE analysis_record_id = ?", [recordId]);
      await connection.execute("DELETE FROM analysis_topics WHERE analysis_record_id = ?", [recordId]);
      await this.insertRelations(connection, "analysis_problem_types", recordId, result.problemTypeIds);
      await this.insertRelations(connection, "analysis_topics", recordId, result.topicIds);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  private async lockRecord(connection: PoolConnection, idempotencyKey: string, ownerToken: string): Promise<number> {
    const [rows] = await connection.execute<IdRow[]>(
      `SELECT id FROM analysis_records WHERE idempotency_key = ? AND status = 'running'
         AND owner_token = ? AND lease_expires_at > CURRENT_TIMESTAMP(3) FOR UPDATE`,
      [idempotencyKey, ownerToken]
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("analysis_record_missing");
    return id;
  }

  private async insertRelations(
    connection: PoolConnection,
    table: "analysis_problem_types" | "analysis_topics",
    recordId: number,
    itemIds: string[]
  ): Promise<void> {
    for (const itemId of itemIds) {
      await connection.execute(
        `INSERT INTO ${table} (analysis_record_id, classification_item_id) VALUES (?, ?)`,
        [recordId, itemId]
      );
    }
  }

  async saveFailure(
    request: AnalysisRequest,
    ownerToken: string,
    errorCode: string,
    errorSummary: string,
    usage?: TokenUsage
  ): Promise<void> {
    await this.pool.execute(
      `UPDATE analysis_records SET status = 'failed', error_code = ?, error_summary = ?,
         prompt_tokens = ?, completion_tokens = ?, total_tokens = ?,
         completed_at = CURRENT_TIMESTAMP(3), owner_token = NULL, lease_expires_at = NULL
       WHERE idempotency_key = ? AND status = 'running' AND owner_token = ?
         AND lease_expires_at > CURRENT_TIMESTAMP(3)`,
      [errorCode.slice(0, 64), errorSummary.slice(0, 500), usage?.promptTokens ?? 0,
        usage?.completionTokens ?? 0, usage?.totalTokens ?? 0, request.idempotencyKey, ownerToken]
    );
  }
}
