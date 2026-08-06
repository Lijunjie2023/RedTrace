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

test("Web保留证据深链路由且只展示四项当前主导航", async () => {
  const [app, shell] = await Promise.all([
    source("apps/web/src/app.tsx"),
    source("apps/web/src/layout/app-shell.tsx")
  ]);
  const routes = [
    "/login",
    "/overview",
    "/insights",
    "/keywords",
    "/content",
    "/content/:contentType/:id",
    "/brands",
    "/data-management",
    "/data-status"
  ];
  for (const route of routes) assert.match(app, new RegExp(`path=\\"${route.replaceAll("/", "\\/")}\\"`));
  assert.match(shell, /const navigation = \[/);
  const navigationBlock = shell.match(/const navigation = \[([\s\S]*?)\] as const/)?.[1] ?? "";
  assert.equal((navigationBlock.match(/\["\//g) ?? []).length, 4);
  assert.doesNotMatch(navigationBlock, /\/insights|\/content/);
  assert.match(navigationBlock, /\/data-management/);
});

test("常见桌面宽度保持问题变化、热榜和代表性原话三栏", async () => {
  const styles = await source("apps/web/src/styles.css");
  assert.match(styles, /\.trend-panel \{ grid-column: span 6;/);
  assert.match(styles, /\.rising-topics, \.risk-evidence \{ grid-column: span 3;/);

  const desktopCollapseBlock = styles.match(/@media \(max-width: 1439px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.doesNotMatch(desktopCollapseBlock, /\.trend-panel|\.rising-topics|\.risk-evidence/);

  assert.doesNotMatch(styles, /@media \(min-width: 1024px\) and \(max-width: 1199px\)/);
});

test("Web响应式外壳占满视口并避免依赖隐藏溢出掩盖布局问题", async () => {
  const styles = await source("apps/web/src/styles.css");
  const bodyBlock = styles.match(/body \{([^}]*)\}/)?.[1] ?? "";
  const mainContentBlock = styles.match(/\.main-content \{([^}]*)\}/)?.[1] ?? "";
  const mobileBlock = styles.match(/@media \(max-width: 767px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";

  assert.doesNotMatch(bodyBlock, /overflow-x:\s*hidden/);
  assert.doesNotMatch(mainContentBlock, /max-width/);
  assert.match(mainContentBlock, /width:\s*calc\(100% - var\(--sidebar-fluid\)\)/);
  assert.match(styles, /--sidebar-fluid:\s*clamp\(/);
  assert.match(styles, /container:\s*sidebar\s*\/\s*inline-size/);
  assert.match(styles, /@container sidebar \(min-width: 8rem\)/);
  assert.match(styles, /@container sidebar \(min-width: 9rem\)/);
  assert.match(styles, /@container sidebar \(min-width: 10rem\)/);
  assert.match(styles, /\.category-dashboard-grid \{[^}]*repeat\(auto-fit,\s*minmax\(/);
  assert.match(styles, /\.content-layout \{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)\s+minmax\(18rem, 24rem\)/);
  assert.match(styles, /@media \(min-width: 768px\) and \(max-width: 1320px\)[\s\S]*?\.trend-scroll-hint/);
  assert.match(mobileBlock, /\.simulation-banner span \{ display: none; \}/);
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
    "data-management.json",
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

test("正式数据模式使用独立管理员凭据并启用安全Cookie", async () => {
  const [server, config] = await Promise.all([
    source("apps/api/src/server.ts"),
    source("apps/api/src/config.ts")
  ]);
  assert.doesNotMatch(server, /正式登录能力尚未准备完成/);
  assert.doesNotMatch(server, /if \(config\.dataMode !== "mock"\)/);
  assert.match(server, /config\.adminUsername/);
  assert.match(server, /config\.adminPassword/);
  assert.match(server, /secure: config\.sessionCookieSecure/);
  assert.match(server, /AUTH_FAILED/);
  assert.match(server, /timingSafeEqual/);
  assert.match(config, /ADMIN_USERNAME/);
  assert.match(config, /ADMIN_PASSWORD/);
  assert.match(config, /SESSION_COOKIE_SECURE/);
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
