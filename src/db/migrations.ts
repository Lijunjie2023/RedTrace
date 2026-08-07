import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";

const MIGRATION_TABLE = "readtrace_schema_migrations";
const MIGRATION_LOCK = "readtrace_schema_migrations_lock";
const STATEMENT_BREAKPOINT = "-- statement-breakpoint";

export interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

interface AppliedMigrationRow extends RowDataPacket {
  version: number;
  name: string;
  checksum: string;
  executedAt: Date;
}

interface LockRow extends RowDataPacket {
  acquired: number;
}

interface MigrationTablePresenceRow extends RowDataPacket {
  tableCount: number;
}

export class MigrationVersionError extends Error {
  constructor() {
    super("数据库迁移版本高于当前程序可识别版本。");
    this.name = "MigrationVersionError";
  }
}

export async function discoverMigrations(directory = path.resolve("migrations")): Promise<MigrationFile[]> {
  const names = (await readdir(directory)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  const migrations = await Promise.all(names.map(async (fileName) => {
    const match = fileName.match(/^(\d{4})_(.+)\.sql$/);
    if (!match?.[1] || !match[2]) throw new Error("migration_filename_invalid");
    const sql = await readFile(path.join(directory, fileName), "utf8");
    return {
      version: Number(match[1]),
      name: match[2],
      sql,
      checksum: createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex")
    };
  }));
  const versions = new Set<number>();
  for (const migration of migrations) {
    if (versions.has(migration.version)) throw new Error("migration_version_duplicate");
    versions.add(migration.version);
  }
  return migrations;
}

type MigrationExecutor = Pool | PoolConnection;

async function ensureMigrationTable(executor: MigrationExecutor): Promise<void> {
  await executor.query(`CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
    version INT UNSIGNED NOT NULL,
    name VARCHAR(191) NOT NULL,
    checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    executed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (version)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
}

export async function migrationStatus(executor: MigrationExecutor, directory = path.resolve("migrations")): Promise<{
  knownVersions: number[];
  appliedVersions: number[];
  appliedMigrations: Array<{ version: number; name: string; executedAt: Date }>;
  pendingVersions: number[];
}> {
  const migrations = await discoverMigrations(directory);
  const [presenceRows] = await executor.query<MigrationTablePresenceRow[]>(
    `SELECT COUNT(*) AS tableCount FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [MIGRATION_TABLE]
  );
  const knownVersions = migrations.map((migration) => migration.version);
  if (presenceRows[0]?.tableCount !== 1) {
    return {
      knownVersions,
      appliedVersions: [],
      appliedMigrations: [],
      pendingVersions: knownVersions
    };
  }
  const [rows] = await executor.query<AppliedMigrationRow[]>(
    `SELECT version, name, checksum, executed_at AS executedAt FROM ${MIGRATION_TABLE} ORDER BY version`
  );
  const highestKnown = knownVersions.at(-1) ?? 0;
  if (rows.some((row) => row.version > highestKnown)) throw new MigrationVersionError();
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const expectedMigration = migrations[index];
    if (!row || !expectedMigration || row.version !== expectedMigration.version) {
      throw new Error("migration_history_not_contiguous");
    }
    const migration = byVersion.get(row.version);
    if (!migration || migration.name !== row.name || migration.checksum !== row.checksum) {
      throw new Error("migration_history_mismatch");
    }
  }
  const appliedVersions = rows.map((row) => row.version);
  const applied = new Set(appliedVersions);
  return {
    knownVersions,
    appliedVersions,
    appliedMigrations: rows.map((row) => ({ version: row.version, name: row.name, executedAt: row.executedAt })),
    pendingVersions: knownVersions.filter((version) => !applied.has(version))
  };
}

export async function runMigrations(pool: Pool): Promise<{ appliedVersions: number[]; pendingBeforeRun: number[] }> {
  const migrations = await discoverMigrations();
  const connection = await pool.getConnection();
  const appliedVersions: number[] = [];
  try {
    await connection.query("SET time_zone = '+00:00'");
    const [lockRows] = await connection.query<LockRow[]>("SELECT GET_LOCK(?, 10) AS acquired", [MIGRATION_LOCK]);
    if (lockRows[0]?.acquired !== 1) throw new Error("migration_lock_unavailable");
    await ensureMigrationTable(connection);
    const status = await migrationStatus(connection);
    const pending = new Set(status.pendingVersions);
    for (const migration of migrations) {
      if (!pending.has(migration.version)) continue;
      const statements = migration.sql.split(STATEMENT_BREAKPOINT).map((statement) => statement.trim()).filter(Boolean);
      for (const statement of statements) await connection.query(statement);
      await connection.query(
        `INSERT INTO ${MIGRATION_TABLE} (version, name, checksum) VALUES (?, ?, ?)`,
        [migration.version, migration.name, migration.checksum]
      );
      appliedVersions.push(migration.version);
    }
    return { appliedVersions, pendingBeforeRun: status.pendingVersions };
  } finally {
    await connection.query("SELECT RELEASE_LOCK(?)", [MIGRATION_LOCK]).catch(() => undefined);
    connection.release();
  }
}

export const expectedBusinessTables = [
  "data_sources",
  "brands",
  "brand_search_terms",
  "collection_tasks",
  "posts",
  "comments",
  "post_interaction_snapshots",
  "comment_interaction_snapshots",
  "raw_field_snapshots",
  "brand_post_matches",
  "collection_cursors",
  "collection_locks",
  "classification_items",
  "analysis_records",
  "analysis_problem_types",
  "analysis_topics",
  "manual_corrections",
  "service_credentials"
] as const;
