import process from "node:process";
import { safeFailure } from "./errors.js";
import { runMigrations } from "./migrations.js";
import { createDatabaseContext } from "./pool.js";

async function main(): Promise<void> {
  let context: Awaited<ReturnType<typeof createDatabaseContext>> | undefined;
  try {
    context = await createDatabaseContext();
    const result = await runMigrations(context.pool);
    console.log(JSON.stringify({
      ok: true,
      appliedCount: result.appliedVersions.length,
      appliedVersions: result.appliedVersions,
      noPendingMigrations: result.pendingBeforeRun.length === 0
    }));
  } catch (error) {
    console.error(JSON.stringify(safeFailure(error)));
    process.exitCode = 1;
  } finally {
    await context?.pool.end().catch(() => undefined);
  }
}

void main();
