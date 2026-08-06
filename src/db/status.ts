import process from "node:process";
import type { RowDataPacket } from "mysql2/promise";
import { safeFailure } from "./errors.js";
import { expectedBusinessTables, migrationStatus } from "./migrations.js";
import { createDatabaseContext } from "./pool.js";

interface TableRow extends RowDataPacket {
  tableName: string;
}

async function main(): Promise<void> {
  let context: Awaited<ReturnType<typeof createDatabaseContext>> | undefined;
  try {
    context = await createDatabaseContext();
    const migration = await migrationStatus(context.pool);
    const placeholders = expectedBusinessTables.map(() => "?").join(", ");
    const [rows] = await context.pool.query<TableRow[]>(
      `SELECT TABLE_NAME AS tableName FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${placeholders}) ORDER BY TABLE_NAME`,
      [...expectedBusinessTables]
    );
    const present = new Set(rows.map((row) => row.tableName));
    console.log(JSON.stringify({
      ok: true,
      appliedMigrations: migration.appliedMigrations,
      pendingVersions: migration.pendingVersions,
      expectedTableCount: expectedBusinessTables.length,
      presentTableCount: present.size,
      presentTables: expectedBusinessTables.filter((table) => present.has(table)),
      missingTables: expectedBusinessTables.filter((table) => !present.has(table))
    }));
  } catch (error) {
    console.error(JSON.stringify(safeFailure(error)));
    process.exitCode = 1;
  } finally {
    await context?.pool.end().catch(() => undefined);
  }
}

void main();
