import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { PersistenceError } from "./errors.js";
import type {
  CollectionProgressDelta,
  CreateApiTaskInput,
  CreatedApiTask,
  CreateTaskInput,
  PersistenceErrorType
} from "./types.js";
import { parseCollectionKeywords } from "../../../packages/contracts/src/index.js";

interface TaskSetupRow extends RowDataPacket {
  dataSourceId: number;
  brandStatus: string;
}

interface TaskStatusRow extends RowDataPacket { status: string }

function positiveId(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new PersistenceError("input_invalid", code);
  return value;
}

export class CollectionTaskRepository {
  constructor(private readonly pool: Pool) {}

  async reconcileAbandonedApiTasks(): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE collection_tasks
       SET succeeded_post_count = stored_post_count,
           failed_post_count = failed_count,
           error_type = CASE WHEN status = 'stopping' THEN NULL ELSE 'collection_process_restarted' END,
           error_summary = CASE WHEN status = 'stopping' THEN NULL ELSE '采集服务重启，原任务无法继续执行。' END,
           finished_at = CURRENT_TIMESTAMP(3),
           status = CASE WHEN status = 'stopping' THEN 'stopped' ELSE 'failed' END
       WHERE status IN ('queued', 'running', 'stopping')
         AND keyword IS NOT NULL AND requested_note_limit IS NOT NULL`
    );
    return result.affectedRows;
  }

  async createTask(input: CreateTaskInput): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO collection_tasks (data_source_id, brand_id, trigger_type, status)
       VALUES (?, ?, ?, 'queued')`,
      [input.dataSourceId, input.brandId, input.triggerType]
    );
    return result.insertId;
  }

  async createApiTask(input: CreateApiTaskInput): Promise<CreatedApiTask> {
    const brandId = positiveId(input.brandId, "brand_id_invalid");
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [brands] = await connection.execute<TaskSetupRow[]>(
        `SELECT data_source_id AS dataSourceId, status AS brandStatus
         FROM brands WHERE id = ? FOR UPDATE`,
        [brandId]
      );
      const brand = brands[0];
      if (!brand) throw new PersistenceError("input_invalid", "brand_not_found");
      if (brand.brandStatus !== "enabled") throw new PersistenceError("input_invalid", "brand_not_enabled");
      const [active] = await connection.execute<RowDataPacket[]>(
        `SELECT id FROM collection_tasks
         WHERE brand_id = ? AND status IN ('queued', 'running', 'stopping') LIMIT 1`,
        [brandId]
      );
      if (active.length > 0) throw new PersistenceError("task_state_conflict", "collection_already_running");
      const keywords = parseCollectionKeywords(input.keyword);
      const searchTerms: CreatedApiTask["searchTerms"] = [];
      for (const keyword of keywords) {
        searchTerms.push({ keyword, searchTermId: await this.ensureSearchTerm(connection, brandId, keyword) });
      }
      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO collection_tasks (
           data_source_id, brand_id, trigger_type, status, keyword, requested_note_limit
         ) VALUES (?, ?, 'manual', 'queued', ?, ?)`,
        [brand.dataSourceId, brandId, input.keyword, input.noteLimit]
      );
      await connection.commit();
      return {
        taskId: result.insertId,
        dataSourceId: brand.dataSourceId,
        brandId,
        searchTerms,
        keyword: input.keyword,
        noteLimit: input.noteLimit
      };
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  private async ensureSearchTerm(connection: PoolConnection, brandId: number, keyword: string): Promise<number> {
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO brand_search_terms (brand_id, term_type, term_value, status, archived_at)
       VALUES (?, 'alias', ?, 'enabled', NULL)
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), status = 'enabled', archived_at = NULL`,
      [brandId, keyword]
    );
    return result.insertId;
  }

  async createRetryTask(failedTaskId: number): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO collection_tasks (data_source_id, brand_id, trigger_type, status, retry_of_task_id)
       SELECT data_source_id, brand_id, 'retry', 'queued', id
       FROM collection_tasks
       WHERE id = ? AND status IN ('failed', 'partial_success')`,
      [failedTaskId]
    );
    if (result.affectedRows !== 1) throw new PersistenceError("task_state_conflict", "retry_source_invalid");
    return result.insertId;
  }

  async startTask(taskId: number, dataSourceId: number, brandId: number): Promise<void> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE collection_tasks
       SET status = 'running', started_at = CURRENT_TIMESTAMP(3),
           finished_at = NULL, error_type = NULL, error_summary = NULL
       WHERE id = ? AND data_source_id = ? AND brand_id = ? AND status = 'queued'`,
      [taskId, dataSourceId, brandId]
    );
    if (result.affectedRows !== 1) throw new PersistenceError("task_state_conflict", "task_not_startable");
  }

  async shouldStop(taskId: number): Promise<boolean> {
    const [rows] = await this.pool.execute<TaskStatusRow[]>(
      "SELECT status FROM collection_tasks WHERE id = ? LIMIT 1",
      [positiveId(taskId, "task_id_invalid")]
    );
    const status = rows[0]?.status;
    if (!status) throw new PersistenceError("input_invalid", "task_not_found");
    return status === "stopping" || status === "stopped";
  }

  async requestStop(taskId: number): Promise<void> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE collection_tasks
       SET finished_at = IF(status = 'queued', CURRENT_TIMESTAMP(3), finished_at),
           stop_requested_at = CURRENT_TIMESTAMP(3),
           status = IF(status = 'queued', 'stopped', 'stopping')
       WHERE id = ? AND status IN ('queued', 'running')`,
      [positiveId(taskId, "task_id_invalid")]
    );
    if (result.affectedRows === 1) return;
    const [rows] = await this.pool.execute<TaskStatusRow[]>(
      "SELECT status FROM collection_tasks WHERE id = ? LIMIT 1",
      [taskId]
    );
    if (!rows[0]) throw new PersistenceError("input_invalid", "task_not_found");
    throw new PersistenceError("task_state_conflict", "task_not_stoppable");
  }

  async addProgress(taskId: number, delta: CollectionProgressDelta): Promise<void> {
    const values = {
      fetchedPostCount: delta.fetchedPostCount ?? 0,
      fetchedCommentCount: delta.fetchedCommentCount ?? 0,
      storedPostCount: delta.storedPostCount ?? 0,
      storedCommentCount: delta.storedCommentCount ?? 0,
      skippedNoCommentPostCount: delta.skippedNoCommentPostCount ?? 0,
      failedCount: delta.failedCount ?? 0
    };
    if (Object.values(values).some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new PersistenceError("input_invalid", "progress_delta_invalid");
    }
    await this.pool.execute(
      `UPDATE collection_tasks SET
         fetched_post_count = fetched_post_count + ?,
         fetched_comment_count = fetched_comment_count + ?,
         stored_post_count = stored_post_count + ?,
         stored_comment_count = stored_comment_count + ?,
         skipped_no_comment_post_count = skipped_no_comment_post_count + ?,
         failed_count = failed_count + ?
       WHERE id = ? AND status IN ('running', 'stopping')`,
      [
        values.fetchedPostCount, values.fetchedCommentCount,
        values.storedPostCount, values.storedCommentCount,
        values.skippedNoCommentPostCount, values.failedCount, taskId
      ]
    );
  }

  async finishApiTask(taskId: number, status: "success" | "partial_success" | "failed", errorType: string | null): Promise<void> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE collection_tasks
       SET status = ?, succeeded_post_count = stored_post_count, failed_post_count = failed_count,
           error_type = ?, error_summary = ?, finished_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND status = 'running'`,
      [status, errorType, errorType ? "采集任务未能完整处理。" : null, taskId]
    );
    if (result.affectedRows === 1) return;
    if (await this.shouldStop(taskId)) await this.finishStopped(taskId);
    else throw new PersistenceError("task_state_conflict", "task_not_running");
  }

  async failApiTask(taskId: number, errorType: string): Promise<void> {
    const safeErrorType = /^[a-z0-9_]{1,64}$/.test(errorType) ? errorType : "collection_processing_failed";
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE collection_tasks
       SET status = 'failed', succeeded_post_count = stored_post_count,
           failed_post_count = failed_count, error_type = ?,
           error_summary = '采集任务未能完整处理。', finished_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND status IN ('queued', 'running')`,
      [safeErrorType, positiveId(taskId, "task_id_invalid")]
    );
    if (result.affectedRows !== 1) throw new PersistenceError("task_state_conflict", "task_not_failable");
  }

  async finishStopped(taskId: number): Promise<void> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE collection_tasks
       SET status = 'stopped', succeeded_post_count = stored_post_count,
           failed_post_count = failed_count, finished_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND status IN ('queued', 'running', 'stopping')`,
      [taskId]
    );
    if (result.affectedRows !== 1) throw new PersistenceError("task_state_conflict", "task_not_stoppable");
  }

  async finishTask(
    taskId: number,
    status: "success" | "partial_success" | "failed",
    succeededPostCount: number,
    failedPostCount: number,
    errorType: PersistenceErrorType | null,
    errorSummary: string | null
  ): Promise<void> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE collection_tasks
       SET status = ?, succeeded_post_count = ?, failed_post_count = ?,
           error_type = ?, error_summary = ?, finished_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND status = 'running'`,
      [status, succeededPostCount, failedPostCount, errorType, errorSummary, taskId]
    );
    if (result.affectedRows !== 1) throw new PersistenceError("task_state_conflict", "task_not_running");
  }

  async failBeforeData(taskId: number, errorType: PersistenceErrorType): Promise<void> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE collection_tasks
       SET status = 'failed', succeeded_post_count = 0, failed_post_count = 0,
           error_type = ?, error_summary = ?,
           started_at = COALESCE(started_at, CURRENT_TIMESTAMP(3)), finished_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND status IN ('queued', 'running')`,
      [errorType, "采集任务在取得内容前失败。", taskId]
    );
    if (result.affectedRows !== 1) throw new PersistenceError("task_state_conflict", "task_not_failable");
  }
}
