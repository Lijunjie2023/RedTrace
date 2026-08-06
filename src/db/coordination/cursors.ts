import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { DatabaseExecutor, DatabaseId, JsonValue } from "./types.js";

export interface AdvanceCollectionCursorInput {
  dataSourceId: DatabaseId;
  brandId: DatabaseId;
  stageCode: string;
  scopeKey?: string;
  cursorValue: JsonValue;
  taskId: DatabaseId;
  expectedCursorVersion: number;
  stageOutcome: "success" | "failed";
}

export type AdvanceCollectionCursorResult =
  | { advanced: true; action: "created" | "updated"; cursorVersion: number }
  | { advanced: false; reason: "stage_failed" | "task_not_eligible" | "stale_cursor" };

interface TaskStateRow extends RowDataPacket {
  status: string;
}

const ELIGIBLE_TASK_STATUSES = new Set(["running", "success", "partial_success"]);

export async function advanceCollectionCursor(
  executor: DatabaseExecutor,
  input: AdvanceCollectionCursorInput
): Promise<AdvanceCollectionCursorResult> {
  if (input.stageOutcome !== "success") return { advanced: false, reason: "stage_failed" };
  if (!Number.isSafeInteger(input.expectedCursorVersion) || input.expectedCursorVersion < 0) {
    throw new RangeError("expectedCursorVersion must be a non-negative safe integer");
  }
  const scopeKey = input.scopeKey ?? "";
  const cursorJson = JSON.stringify(input.cursorValue);
  const [result] = input.expectedCursorVersion === 0
    ? await executor.execute<ResultSetHeader>(
      `INSERT INTO collection_cursors (
         data_source_id, brand_id, stage_code, scope_key, cursor_value,
         last_successful_task_id, cursor_version, advanced_at, created_at, updated_at
       )
       SELECT ?, ?, ?, ?, CAST(? AS JSON), id, 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)
       FROM collection_tasks
       WHERE id = ? AND data_source_id = ? AND brand_id = ?
         AND status IN ('running', 'success', 'partial_success')
       ON DUPLICATE KEY UPDATE id = collection_cursors.id + (LAST_INSERT_ID(0) * 0)`,
      [
        input.dataSourceId,
        input.brandId,
        input.stageCode,
        scopeKey,
        cursorJson,
        input.taskId,
        input.dataSourceId,
        input.brandId
      ]
    )
    : await executor.execute<ResultSetHeader>(
      `UPDATE collection_cursors
       SET cursor_value = CAST(? AS JSON),
           last_successful_task_id = ?,
           advanced_at = UTC_TIMESTAMP(3),
           updated_at = UTC_TIMESTAMP(3),
           cursor_version = collection_cursors.cursor_version + 1
             + (LAST_INSERT_ID(collection_cursors.id) * 0)
       WHERE collection_cursors.data_source_id = ? AND collection_cursors.brand_id = ?
         AND collection_cursors.stage_code = ? AND collection_cursors.scope_key = ?
         AND collection_cursors.cursor_version = ?
         AND EXISTS (
           SELECT 1 FROM collection_tasks
           WHERE collection_tasks.id = ?
             AND collection_tasks.data_source_id = ?
             AND collection_tasks.brand_id = ?
             AND collection_tasks.status IN ('running', 'success', 'partial_success')
         )`,
      [
        cursorJson,
        input.taskId,
        input.dataSourceId,
        input.brandId,
        input.stageCode,
        scopeKey,
        input.expectedCursorVersion,
        input.taskId,
        input.dataSourceId,
        input.brandId
      ]
    );
  const nextVersion = input.expectedCursorVersion + 1;
  if (result.affectedRows > 0 && result.insertId > 0) {
    return {
      advanced: true,
      action: input.expectedCursorVersion === 0 ? "created" : "updated",
      cursorVersion: nextVersion
    };
  }
  const [taskRows] = await executor.execute<TaskStateRow[]>(
    `SELECT status FROM collection_tasks
     WHERE id = ? AND data_source_id = ? AND brand_id = ?`,
    [input.taskId, input.dataSourceId, input.brandId]
  );
  const task = taskRows[0];
  if (!task || !ELIGIBLE_TASK_STATUSES.has(task.status)) {
    return { advanced: false, reason: "task_not_eligible" };
  }
  return { advanced: false, reason: "stale_cursor" };
}
