import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CredentialCrypto } from "../src/credentials/crypto.js";
import {
  CollectionCredentialInputSchema,
  CollectionRunCreateInputSchema,
  CollectionTaskStatusSchema
} from "../packages/contracts/src/index.js";

test("凭证使用随机向量加密且只能由正确主密钥解密", () => {
  const key = Buffer.alloc(32, 7);
  const crypto = new CredentialCrypto(key);
  const first = crypto.encrypt("secret-token-value");
  const second = crypto.encrypt("secret-token-value");
  assert.notEqual(first.ciphertext, "secret-token-value");
  assert.notDeepEqual(first, second);
  assert.equal(crypto.decrypt(first), "secret-token-value");
  assert.throws(() => new CredentialCrypto(Buffer.alloc(32, 8)).decrypt(first));
});

test("采集控制契约限制凭证、关键词、帖子上限和任务状态", () => {
  assert.equal(CollectionCredentialInputSchema.parse({ secret: "token-value" }).secret, "token-value");
  assert.throws(() => CollectionCredentialInputSchema.parse({ secret: "   " }));
  assert.deepEqual(CollectionRunCreateInputSchema.parse({ brandId: "1", keyword: "卡萨帝", noteLimit: 3 }), {
    brandId: "1",
    keyword: "卡萨帝",
    noteLimit: 3
  });
  assert.throws(() => CollectionRunCreateInputSchema.parse({ keyword: "卡萨帝", noteLimit: 11 }));
  assert.equal(CollectionTaskStatusSchema.parse("STOPPING"), "STOPPING");
  assert.equal(CollectionTaskStatusSchema.parse("STOPPED"), "STOPPED");
});

test("定时分析和手动分析优先读取后台保存的 DeepSeek 凭证", async () => {
  const [config, cli, server] = await Promise.all([
    readFile("src/analysis/config.ts", "utf8"),
    readFile("src/analysis/run-all-cli.ts", "utf8"),
    readFile("apps/api/src/server.ts", "utf8")
  ]);
  assert.match(config, /ServiceCredentialRepository/);
  assert.match(config, /getSecret\("DEEPSEEK"\)/);
  assert.match(cli, /loadDeepSeekConfigForPool/);
  assert.match(server, /loadDeepSeekConfigForPool/);
});

test("数据库迁移只新增凭证与采集进度结构并保留旧数据", async () => {
  const migration = await readFile("migrations/0005_api_collection_console.sql", "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS service_credentials/i);
  assert.match(migration, /ciphertext/i);
  assert.match(migration, /auth_tag/i);
  assert.match(migration, /fetched_post_count/i);
  assert.match(migration, /skipped_no_comment_post_count/i);
  assert.doesNotMatch(migration, /\b(?:DROP\s+TABLE|TRUNCATE|DELETE)\b/i);
});

test("管理员接口包含凭证配置、开始采集、停止采集和持久化进度", async () => {
  const [server, runner] = await Promise.all([
    readFile("apps/api/src/server.ts", "utf8"),
    readFile("src/collection/run.ts", "utf8")
  ]);
  assert.match(server, /\/service-credentials/);
  assert.match(server, /\/collection-runs\/[^/]+\/stop/);
  assert.match(server, /status\(202\)/);
  assert.match(runner, /skippedNoCommentPostCount/);
  assert.match(runner, /shouldStop/);
  assert.doesNotMatch(runner, /console\.(?:log|error)\([^\n]*(?:token|secret|apiKey|Authorization)/);
});

test("前端提供API采集入口、凭证状态、开始停止和六项进度", async () => {
  const [app, page, client] = await Promise.all([
    readFile("apps/web/src/app.tsx", "utf8"),
    readFile("apps/web/src/pages/data-collection.tsx", "utf8"),
    readFile("apps/web/src/api/client.ts", "utf8")
  ]);
  assert.match(app, /data-collection/);
  assert.match(page, /开始采集/);
  assert.match(page, /停止采集/);
  for (const label of ["获取帖子", "获取评论", "入库帖子", "入库评论", "无评论跳过", "失败数量"]) {
    assert.match(page, new RegExp(label));
  }
  assert.match(client, /saveServiceCredential/);
  assert.match(client, /stopCollection/);
});
