import process from "node:process";
import { runAnalysisBatch } from "./batch.js";
import { AnalysisConfigError, loadDeepSeekConfig } from "./config.js";
import { DeepSeekClient } from "./deepseek-client.js";
import { MysqlAnalysisStore } from "./mysql-store.js";
import type { AnalysisContentType } from "./types.js";
import { createDatabaseContext } from "../db/pool.js";

export interface AnalysisCliOptions {
  contentType: AnalysisContentType;
  limit?: number;
}

function valueAfter(args: string[], index: number, name: string): string | undefined {
  const current = args[index];
  if (current?.startsWith(`${name}=`)) return current.slice(name.length + 1);
  if (current === name) return args[index + 1];
  return undefined;
}

export function parseAnalysisCliOptions(args: string[]): AnalysisCliOptions {
  let contentType: AnalysisContentType | undefined;
  let limit: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const typeValue = valueAfter(args, index, "--content-type")?.toUpperCase();
    if (typeValue) {
      if (typeValue !== "POST" && typeValue !== "COMMENT") throw new Error("content_type_invalid");
      contentType = typeValue;
    }
    const limitValue = valueAfter(args, index, "--limit");
    if (limitValue) {
      if (!/^\d+$/.test(limitValue)) throw new Error("limit_invalid");
      limit = Number(limitValue);
    }
  }
  if (!contentType) throw new Error("content_type_required");
  return limit === undefined ? { contentType } : { contentType, limit };
}

export function safeCliErrorCode(error: unknown): string {
  if (error instanceof AnalysisConfigError) return "analysis_config_invalid";
  if (error instanceof Error && [
    "content_type_invalid", "limit_invalid", "content_type_required", "analysis_limit_invalid"
  ].includes(error.message)) return error.message;
  return "analysis_failed";
}

async function main(): Promise<void> {
  let context: Awaited<ReturnType<typeof createDatabaseContext>> | undefined;
  try {
    const config = loadDeepSeekConfig();
    const options = parseAnalysisCliOptions(process.argv.slice(2));
    context = await createDatabaseContext();
    const summary = await runAnalysisBatch({
      store: new MysqlAnalysisStore(context.pool),
      client: new DeepSeekClient(config),
      config,
      contentType: options.contentType,
      limit: options.limit ?? config.batchLimit
    });
    console.log(JSON.stringify({ ok: summary.failed === 0, ...summary }));
    if (summary.failed > 0) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, errorCode: safeCliErrorCode(error) }));
    process.exitCode = 1;
  } finally {
    await context?.pool.end().catch(() => undefined);
  }
}

void main();
