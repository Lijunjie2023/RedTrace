import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Pool } from "mysql2/promise";
import {
  MigrationVersionError,
  discoverMigrations,
  expectedBusinessTables,
  migrationStatus
} from "../src/db/migrations.js";

async function withMigrationDirectory(
  files: Record<string, string>,
  run: (directory: string) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "readtrace-migrations-"));
  try {
    await Promise.all(Object.entries(files).map(([name, sql]) => writeFile(path.join(directory, name), sql, "utf8")));
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function executorFor(appliedRows: Array<Record<string, unknown>>, tableCount = 1): {
  executor: Pool;
  statements: string[];
} {
  const statements: string[] = [];
  const executor = {
    query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes("information_schema.TABLES")) return [[{ tableCount }], []];
      if (sql.includes("FROM readtrace_schema_migrations")) return [appliedRows, []];
      throw new Error(`unexpected_query:${sql}`);
    }
  } as unknown as Pool;
  return { executor, statements };
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

test("迁移发现按版本排序并计算换行稳定的校验和", async () => {
  await withMigrationDirectory({
    "0002_second.sql": "SELECT 2;\r\n",
    "0001_first.sql": "SELECT 1;\n",
    "README.md": "ignored"
  }, async (directory) => {
    const migrations = await discoverMigrations(directory);
    assert.deepEqual(migrations.map(({ version, name }) => ({ version, name })), [
      { version: 1, name: "first" },
      { version: 2, name: "second" }
    ]);
    assert.equal(migrations[1]?.checksum, checksum("SELECT 2;\n"));
  });
});

test("重复迁移版本被拒绝", async () => {
  await withMigrationDirectory({
    "0001_first.sql": "SELECT 1;",
    "0001_duplicate.sql": "SELECT 2;"
  }, async (directory) => {
    await assert.rejects(() => discoverMigrations(directory), /migration_version_duplicate/);
  });
});

test("迁移表不存在时status保持只读并报告全部待执行版本", async () => {
  await withMigrationDirectory({ "0001_first.sql": "SELECT 1;" }, async (directory) => {
    const { executor, statements } = executorFor([], 0);
    const status = await migrationStatus(executor, directory);

    assert.deepEqual(status, {
      knownVersions: [1],
      appliedVersions: [],
      appliedMigrations: [],
      pendingVersions: [1]
    });
    assert.equal(statements.length, 1);
    assert.match(statements[0] ?? "", /^SELECT COUNT\(\*\)/);
    assert.equal(statements.some((statement) => /\bCREATE\b/i.test(statement)), false);
  });
});

test("高于程序版本的迁移历史被拒绝", async () => {
  await withMigrationDirectory({ "0001_first.sql": "SELECT 1;" }, async (directory) => {
    const { executor } = executorFor([{
      version: 2,
      name: "future",
      checksum: "a".repeat(64),
      executedAt: new Date("2026-01-01T00:00:00.000Z")
    }]);
    await assert.rejects(() => migrationStatus(executor, directory), MigrationVersionError);
  });
});

test("迁移历史跳号被拒绝", async () => {
  const files = {
    "0001_first.sql": "SELECT 1;",
    "0002_second.sql": "SELECT 2;",
    "0003_third.sql": "SELECT 3;"
  };
  await withMigrationDirectory(files, async (directory) => {
    const { executor } = executorFor([
      {
        version: 1,
        name: "first",
        checksum: checksum(files["0001_first.sql"]),
        executedAt: new Date("2026-01-01T00:00:00.000Z")
      },
      {
        version: 3,
        name: "third",
        checksum: checksum(files["0003_third.sql"]),
        executedAt: new Date("2026-01-03T00:00:00.000Z")
      }
    ]);
    await assert.rejects(() => migrationStatus(executor, directory), /migration_history_not_contiguous/);
  });
});

test("迁移名称或校验和与已执行历史不一致时被拒绝", async () => {
  await withMigrationDirectory({ "0001_first.sql": "SELECT 1;" }, async (directory) => {
    const { executor } = executorFor([{
      version: 1,
      name: "first",
      checksum: "f".repeat(64),
      executedAt: new Date("2026-01-01T00:00:00.000Z")
    }]);
    await assert.rejects(() => migrationStatus(executor, directory), /migration_history_mismatch/);
  });
});

test("首版SQL包含完整采集结构且没有清库语句", async () => {
  const sql = await readFile(path.resolve("migrations/0001_collection_schema.sql"), "utf8");
  const tableNames = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z0-9_]+)/gi)].map((match) => match[1]);

  assert.deepEqual(tableNames, [...expectedBusinessTables].slice(0, 12));
  assert.equal(tableNames.length, 12);
  assert.match(sql, /UNIQUE KEY uq_posts_source_platform_id \(data_source_id, platform_post_id\)/);
  assert.match(sql, /UNIQUE KEY uq_comments_source_platform_id \(data_source_id, platform_comment_id\)/);
  assert.match(sql, /UNIQUE KEY uq_brand_post_matches \(brand_id, search_term_id, post_id\)/);
  assert.match(sql, /FOREIGN KEY \([^)]+\) REFERENCES [a-z_]+ \([^)]+\) ON DELETE RESTRICT ON UPDATE RESTRICT/);
  assert.match(sql, /platform_post_id VARCHAR\(191\) CHARACTER SET ascii COLLATE ascii_bin NOT NULL/);
  assert.match(sql, /platform_comment_id VARCHAR\(191\) CHARACTER SET ascii COLLATE ascii_bin NOT NULL/);
  assert.match(sql, /DATETIME\(3\)/);
  assert.match(sql, /CREATE TRIGGER trg_collection_tasks_require_enabled_brand/);
  assert.match(sql, /VALUES \('xiaohongshu', '小红书', 'social_content', 'enabled'\)/);
  assert.doesNotMatch(sql, /\bDROP\s+DATABASE\b/i);
  assert.doesNotMatch(sql, /\bTRUNCATE(?:\s+TABLE)?\b/i);
});

test("第二版SQL保留模型历史、分类关联和独立人工修正", async () => {
  const sql = await readFile(path.resolve("migrations/0002_content_analysis.sql"), "utf8");
  const tableNames = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z0-9_]+)/gi)].map((match) => match[1]);

  assert.deepEqual(tableNames, [
    "classification_items",
    "analysis_records",
    "analysis_problem_types",
    "analysis_topics",
    "manual_corrections"
  ]);
  assert.deepEqual([...expectedBusinessTables], [
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
    ...tableNames
  ]);
  assert.match(sql, /UNIQUE KEY uq_analysis_records_idempotency \(idempotency_key\)/);
  assert.match(sql, /input_digest CHAR\(64\).*NOT NULL/);
  assert.match(sql, /taxonomy_digest CHAR\(64\).*NOT NULL/);
  assert.match(sql, /prompt_version VARCHAR\(64\).*NOT NULL/);
  assert.match(sql, /CONSTRAINT chk_analysis_records_target CHECK/);
  assert.match(sql, /patch_json JSON NOT NULL/);
  assert.match(sql, /deleted_at DATETIME\(3\) NULL/);
  assert.doesNotMatch(sql, /\bDROP\s+DATABASE\b/i);
  assert.doesNotMatch(sql, /\bTRUNCATE(?:\s+TABLE)?\b/i);
});

test("第三版SQL只为分析任务增加原子租约字段", async () => {
  const sql = await readFile(path.resolve("migrations/0003_analysis_claim_lease.sql"), "utf8");
  assert.match(sql, /^ALTER TABLE analysis_records/);
  assert.match(sql, /owner_token CHAR\(36\)/);
  assert.match(sql, /lease_expires_at DATETIME\(3\)/);
  assert.match(sql, /UNIQUE KEY uq_analysis_records_owner_token \(owner_token\)/);
  assert.match(sql, /KEY idx_analysis_records_claim \(status, lease_expires_at\)/);
  assert.doesNotMatch(sql, /\bDROP\b|\bTRUNCATE\b|\bDELETE\b/i);
});

test("第四版SQL把产品品类统一为七项业务词表", async () => {
  const sql = await readFile(path.resolve("migrations/0004_product_category_taxonomy.sql"), "utf8");

  for (const displayName of ["冰箱", "洗衣机", "空调", "水联网", "厨电", "彩电", "其他"]) {
    assert.match(sql, new RegExp(`'${displayName}'`));
  }
  assert.match(sql, /classification_type\s*=\s*'category'/);
  assert.match(sql, /WHERE classification_type = 'category' AND item_code = 'water_heater'/);
  assert.match(sql, /ON DUPLICATE KEY UPDATE/);
  assert.doesNotMatch(sql, /\bid\s*=/i);
  assert.doesNotMatch(sql, /\bDROP\b|\bTRUNCATE\b|\bDELETE\b/i);
});
