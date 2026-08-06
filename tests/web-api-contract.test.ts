import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function source(filePath: string): Promise<string> {
  return readFile(path.resolve(filePath), "utf8");
}

test("前后端统一使用v1采集任务路由", async () => {
  const [server, client] = await Promise.all([
    source("apps/api/src/server.ts"),
    source("apps/web/src/api/client.ts")
  ]);

  for (const route of [
    "/brands/:brandId/collection-runs",
    "/collection-runs",
    "/collection-runs/:taskId/retries"
  ]) {
    assert.match(server, new RegExp(route.replaceAll("/", "\\/")));
  }
  assert.match(server, /const API_ROOT = "\/api\/v1"/);
  assert.match(client, /\/collection-runs/);
  assert.doesNotMatch(client, /collectionTasks/);
});

test("Web提供七条业务路由且只有五项主导航", async () => {
  const [app, shell] = await Promise.all([
    source("apps/web/src/app.tsx"),
    source("apps/web/src/layout/app-shell.tsx")
  ]);
  const routes = [
    "/login",
    "/overview",
    "/insights",
    "/content",
    "/content/:contentType/:id",
    "/brands",
    "/data-status"
  ];
  for (const route of routes) assert.match(app, new RegExp(`path=\\"${route.replaceAll("/", "\\/")}\\"`));
  assert.match(shell, /const navigation = \[/);
  const navigationBlock = shell.match(/const navigation = \[([\s\S]*?)\] as const/)?.[1] ?? "";
  assert.equal((navigationBlock.match(/\["\//g) ?? []).length, 5);
});

test("模拟fixture明确标识模拟且不包含真实网络链接", async () => {
  const manifest = JSON.parse(await source("fixtures/web-api/manifest.json")) as {
    isSimulated?: boolean;
    fixtureVersion?: string;
  };
  assert.equal(manifest.isSimulated, true);
  assert.ok(manifest.fixtureVersion);

  const fixtureNames = [
    "overview.json",
    "insights.json",
    "contents.json",
    "brands.json",
    "classifications.json",
    "collection-runs.json"
  ];
  for (const name of fixtureNames) {
    const text = await source(`fixtures/web-api/${name}`);
    assert.doesNotMatch(text, /https?:\/\//i, `${name}不得伪装真实证据链接`);
  }
});

test("Mock模式不会静态加载MySQL仓储", async () => {
  const [server, mockRepository] = await Promise.all([
    source("apps/api/src/server.ts"),
    source("apps/api/src/repositories/mock.ts")
  ]);
  assert.match(server, /await import\("\.\/repositories\/mysql\.js"\)/);
  assert.doesNotMatch(server, /from "\.\/repositories\/mysql\.js"/);
  assert.doesNotMatch(mockRepository, /mysql2|createDatabaseContext|\.env\.local/);
});

test("正式数据模式不会接受本地模拟登录", async () => {
  const server = await source("apps/api/src/server.ts");
  assert.match(server, /if \(config\.dataMode !== "mock"\)/);
  assert.match(server, /正式登录能力尚未准备完成/);
  assert.match(server, /AUTH_FAILED/);
  assert.match(server, /timingSafeEqual/);
});

test("错误包、撤销修正和LIVE混合分页保留安全边界", async () => {
  const [server, mockRepository, mysqlRepository] = await Promise.all([
    source("apps/api/src/server.ts"),
    source("apps/api/src/repositories/mock.ts"),
    source("apps/api/src/repositories/mysql.ts")
  ]);
  assert.match(server, /meta: meta\(request\.id\)/);
  assert.match(mockRepository, /modelAnalysis/);
  assert.match(mockRepository, /structuredClone\(content\.modelAnalysis\)/);
  assert.match(mysqlRepository, /contentType/);
  assert.match(mysqlRepository, /dataNotReady\(\)/);
});
