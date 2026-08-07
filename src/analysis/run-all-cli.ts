import process from "node:process";
import { AnalysisConfigError, loadDeepSeekConfigForPool } from "./config.js";
import { safeRunSummary, startUnifiedAnalysis } from "./run-all.js";
import { createDatabaseContext } from "../db/pool.js";

async function main(): Promise<void> {
  let context: Awaited<ReturnType<typeof createDatabaseContext>> | undefined;
  try {
    context = await createDatabaseContext();
    const config = await loadDeepSeekConfigForPool(context.pool);
    const run = await startUnifiedAnalysis({ pool: context.pool, config, source: "automatic" });
    if (!run.started) {
      console.log(JSON.stringify({ started: false, reason: "already_running" }));
      return;
    }
    const summary = await run.completion!;
    console.log(JSON.stringify({ started: true, ...safeRunSummary(summary) }));
    if (summary.status === "failed") process.exitCode = 1;
  } catch (error) {
    const errorCode = error instanceof AnalysisConfigError ? "analysis_config_invalid" : "analysis_failed";
    console.error(JSON.stringify({ started: false, errorCode }));
    process.exitCode = 1;
  } finally {
    await context?.pool.end().catch(() => undefined);
  }
}

void main();
