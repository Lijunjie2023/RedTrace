import type { Pool, ResultSetHeader } from "mysql2/promise";
import { PersistenceError } from "./errors.js";
import type { CreateTaskInput, PersistenceErrorType } from "./types.js";

export class CollectionTaskRepository {
  constructor(private readonly pool: Pool) {}

  async createTask(input: CreateTaskInput): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO collection_tasks (data_source_id, brand_id, trigger_type, status)
       VALUES (?, ?, ?, 'queued')`,
      [input.dataSourceId, input.brandId, input.triggerType]
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
