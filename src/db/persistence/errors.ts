import type { PersistenceErrorType } from "./types.js";

export class PersistenceError extends Error {
  readonly errorType: PersistenceErrorType;

  constructor(errorType: PersistenceErrorType, message: string) {
    super(message);
    this.name = "PersistenceError";
    this.errorType = errorType;
  }
}

export function persistenceErrorType(error: unknown): PersistenceErrorType {
  return error instanceof PersistenceError ? error.errorType : "database_write_failed";
}

export function safePersistenceSummary(errorType: PersistenceErrorType): string {
  switch (errorType) {
    case "input_invalid": return "采集内容字段不符合持久化要求。";
    case "task_state_conflict": return "采集任务状态不允许执行当前操作。";
    case "raw_snapshot_sanitize_failed": return "原始字段脱敏或序列化失败，快照未保存。";
    case "database_write_failed": return "单篇采集内容持久化失败。";
  }
}
