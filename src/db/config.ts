import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import type { PoolOptions } from "mysql2/promise";

export type SslMode = "required" | "preferred" | "disabled";

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  sslMode: SslMode;
  sslCaFile: string | null;
  connectionLimit: number;
}

export class DatabaseConfigError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`数据库配置无效：${field}`);
    this.name = "DatabaseConfigError";
    this.field = field;
  }
}

function required(env: NodeJS.ProcessEnv, field: string): string {
  const value = env[field]?.trim();
  if (!value) throw new DatabaseConfigError(field);
  return value;
}

function requiredPassword(env: NodeJS.ProcessEnv): string {
  const value = env.MYSQL_PASSWORD;
  if (value === undefined || value.length === 0) throw new DatabaseConfigError("MYSQL_PASSWORD");
  return value;
}

function integer(env: NodeJS.ProcessEnv, field: string, fallback: number, minimum: number, maximum: number): number {
  const raw = env[field]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new DatabaseConfigError(field);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new DatabaseConfigError(field);
  return value;
}

export function validateDatabaseConfig(env: NodeJS.ProcessEnv): DatabaseConfig {
  const sslModeValue = (env.MYSQL_SSL_MODE?.trim().toLowerCase() || "required") as SslMode;
  if (!(["required", "preferred", "disabled"] as string[]).includes(sslModeValue)) {
    throw new DatabaseConfigError("MYSQL_SSL_MODE");
  }
  return {
    host: required(env, "MYSQL_HOST"),
    port: integer(env, "MYSQL_PORT", 3306, 1, 65_535),
    user: required(env, "MYSQL_USER"),
    password: requiredPassword(env),
    database: required(env, "MYSQL_DATABASE"),
    sslMode: sslModeValue,
    sslCaFile: env.MYSQL_SSL_CA_FILE?.trim() || null,
    connectionLimit: integer(env, "DB_CONNECTION_LIMIT", 5, 1, 10)
  };
}

export function loadDatabaseConfig(): DatabaseConfig {
  dotenv.config({ path: path.resolve(".env.local"), quiet: true });
  return validateDatabaseConfig(process.env);
}

export async function toPoolOptions(config: DatabaseConfig): Promise<PoolOptions> {
  let ssl: PoolOptions["ssl"];
  if (config.sslMode !== "disabled") {
    if (config.sslCaFile) {
      try {
        ssl = { ca: await readFile(config.sslCaFile, "utf8"), rejectUnauthorized: true };
      } catch {
        throw new DatabaseConfigError("MYSQL_SSL_CA_FILE");
      }
    } else {
      ssl = { rejectUnauthorized: config.sslMode === "required" };
    }
  }
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    charset: "utf8mb4",
    timezone: "Z",
    waitForConnections: true,
    connectionLimit: config.connectionLimit,
    queueLimit: 0,
    enableKeepAlive: true,
    multipleStatements: false,
    ...(ssl ? { ssl } : {})
  };
}
