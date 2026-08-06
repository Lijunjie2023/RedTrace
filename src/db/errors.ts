import { DatabaseConfigError } from "./config.js";

export type DatabaseErrorType =
  | "config_invalid"
  | "authentication_failed"
  | "database_access_denied"
  | "ssl_unavailable"
  | "connection_failed"
  | "migration_version_unsupported"
  | "migration_failed";

interface MysqlLikeError {
  code?: unknown;
  errno?: unknown;
  message?: unknown;
}

export function classifyDatabaseError(error: unknown): { errorType: DatabaseErrorType; field?: string } {
  if (error instanceof DatabaseConfigError) return { errorType: "config_invalid", field: error.field };
  const mysqlError = error as MysqlLikeError;
  const code = typeof mysqlError?.code === "string" ? mysqlError.code : "";
  if (code === "ER_ACCESS_DENIED_ERROR") return { errorType: "authentication_failed" };
  if (["ER_DBACCESS_DENIED_ERROR", "ER_BAD_DB_ERROR", "ER_TABLEACCESS_DENIED_ERROR"].includes(code)) {
    return { errorType: "database_access_denied" };
  }
  const message = typeof mysqlError?.message === "string" ? mysqlError.message : "";
  if (
    code.startsWith("HANDSHAKE_SSL")
    || code.includes("CERT")
    || code.includes("TLS")
    || /ssl|tls|certificate|self[- ]signed/i.test(message)
  ) return { errorType: "ssl_unavailable" };
  if (["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "PROTOCOL_CONNECTION_LOST"].includes(code)) {
    return { errorType: "connection_failed" };
  }
  if (error instanceof Error && error.name === "MigrationVersionError") return { errorType: "migration_version_unsupported" };
  return { errorType: "migration_failed" };
}

export function safeFailure(error: unknown): { ok: false; errorType: DatabaseErrorType; field?: string } {
  const classified = classifyDatabaseError(error);
  return { ok: false, ...classified };
}
