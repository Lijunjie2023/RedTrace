import assert from "node:assert/strict";
import { OverviewDataSchema } from "@readtrace/contracts";
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

test("Web保留证据深链路由并在主导航展示内容明细", async () => {
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
    "/data-collection",
    "/data-management",
    "/data-status"
  ];
  for (const route of routes) assert.match(app, new RegExp(`path=\\"${route.replaceAll("/", "\\/")}\\"`));
  assert.match(shell, /const navigation = \[/);
  const navigationBlock = shell.match(/const navigation = \[([\s\S]*?)\] as const/)?.[1] ?? "";
  assert.equal((navigationBlock.match(/\["\//g) ?? []).length, 6);
  assert.doesNotMatch(navigationBlock, /\/insights/);
  assert.match(navigationBlock, /\/content/);
  assert.match(navigationBlock, /\/data-collection/);
  assert.match(navigationBlock, /\/data-management/);
});

test("常见桌面宽度保持问题变化、热榜和代表性原话三栏", async () => {
  const [overview, styles] = await Promise.all([
    source("apps/web/src/pages/overview.tsx"),
    source("apps/web/src/styles.css")
  ]);

  assert.match(overview, /className="overview-primary-row"[\s\S]*className="trend-panel"[\s\S]*className="rising-topics"[\s\S]*<EvidencePanel/);
  assert.match(styles, /\.overview-primary-row \{[^}]*grid-template-columns:\s*minmax\(0,\s*4fr\)\s+repeat\(2,\s*minmax\(0,\s*3fr\)\)/);
  assert.match(styles, /\.overview-primary-row > \.panel \{[^}]*min-width:\s*0/);
  assert.doesNotMatch(styles, /\.trend-panel \{[^}]*grid-column:\s*span/);
  assert.doesNotMatch(styles, /\.rising-topics, \.risk-evidence \{[^}]*grid-column:\s*span/);

  const desktopCollapseBlock = styles.match(/@media \(max-width: 1439px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.doesNotMatch(desktopCollapseBlock, /\.trend-panel|\.rising-topics|\.risk-evidence/);

  assert.doesNotMatch(styles, /@media \(min-width: 1024px\) and \(max-width: 1439px\) \{[\s\S]*?\.trend-panel/);
});

test("首页主三栏等高且趋势内容填满左栏", async () => {
  const [overview, styles] = await Promise.all([
    source("apps/web/src/pages/overview.tsx"),
    source("apps/web/src/styles.css")
  ]);

  assert.match(styles, /--overview-primary-panel-height:\s*clamp\(/);
  assert.match(styles, /\.trend-panel, \.rising-topics, \.risk-evidence \{[^}]*height:\s*var\(--overview-primary-panel-height\)/);
  assert.match(styles, /\.trend-panel \{[^}]*display:\s*flex[^}]*flex-direction:\s*column/);
  assert.match(styles, /\.trend-panel \.trend-visual \{[^}]*flex:\s*1/);
  assert.match(styles, /\.trend-panel \.trend-visual svg \{[^}]*height:\s*100%/);
  assert.match(overview, /<path d=\{path\} \/>/);
  assert.match(styles, /\.trend-series--negative path \{[^}]*fill:\s*none/);
  assert.doesNotMatch(styles, /\.trend-series--negative path, \.trend-series--negative circle \{[^}]*fill:\s*var\(--color-risk\)/);
});

test("侧边栏品牌区不再显示RT方框", async () => {
  const [shell, styles] = await Promise.all([
    source("apps/web/src/layout/app-shell.tsx"),
    source("apps/web/src/styles.css")
  ]);

  assert.match(shell, /className="brandmark"[^>]*><div><strong><b>Red<\/b>Trace<\/strong>/);
  assert.doesNotMatch(shell, /<span><b>R<\/b>T<\/span>/);
  assert.doesNotMatch(styles, /\.brandmark > span/);
  assert.match(styles, /\.brandmark \{[^}]*display:\s*none/);
  assert.match(styles, /@container sidebar \(min-width:\s*8rem\) \{\s*\.brandmark \{[^}]*display:\s*flex/);
});

test("问题热榜最多十条降序且表头保持横排", async () => {
  const [overview, styles] = await Promise.all([
    source("apps/web/src/pages/overview.tsx"),
    source("apps/web/src/styles.css")
  ]);

  assert.match(overview, /sort\(\(left, right\) => right\.evidenceCount - left\.evidenceCount\)\.slice\(0, 10\)/);
  assert.match(overview, /className="topic-ranking-table"/);
  assert.match(overview, /className="topic-ranking-head topic-ranking-grid"/);
  assert.match(overview, /className="topic-ranking-head__rank">排名<\/div>/);
  assert.match(overview, /className="topic-ranking-head__problem">问题<\/div>/);
  assert.match(overview, /className="topic-ranking-head__change">较上期<\/div>/);
  assert.match(overview, /className="topic-ranking-head__posts">影响帖子<\/div>/);
  assert.match(overview, /className="topic-ranking-head__comments">评论<\/div>/);
  assert.match(overview, /className="topic-ranking-row topic-ranking-grid"/);
  assert.match(styles, /--topic-ranking-columns:/);
  assert.match(styles, /\.topic-ranking-grid \{[^}]*grid-template-columns:\s*var\(--topic-ranking-columns\)/);
  assert.match(styles, /\.topic-ranking-head \{[^}]*white-space:\s*nowrap/);
  assert.match(styles, /\.topic-rank \{[^}]*border-radius:/);
  assert.match(styles, /\.topic-rank--1 \{[^}]*background:/);
  assert.match(styles, /\.topic-rank--2 \{[^}]*background:/);
  assert.match(styles, /\.topic-rank--3 \{[^}]*background:/);
});

test("品类内容对比按业务顺序最多单行展示六项", async () => {
  const [overview, styles] = await Promise.all([
    source("apps/web/src/pages/overview.tsx"),
    source("apps/web/src/styles.css")
  ]);

  assert.match(overview, /const CATEGORY_DISPLAY_ORDER = \["冰箱", "洗衣机", "空调", "水联网", "厨电", "彩电", "其他"\] as const/);
  assert.match(overview, /categoryRanking[\s\S]*?slice\(0, 6\)/);
  assert.match(overview, /className="category-dashboard-layout"[\s\S]*?className="category-dashboard-labels"/);
  assert.match(overview, /"--category-count":\s*categories\.length/);
  assert.doesNotMatch(overview, /<small>当前内容量<\/small>/);
  assert.doesNotMatch(overview, /onToggle|点击品类后|onClick=\{\(\) => onToggle/);
  assert.doesNotMatch(styles, /\.category-dashboard-grid > button:hover|\.category-dashboard-grid > button\.is-active/);
  assert.match(styles, /\.category-dashboard-layout \{[^}]*grid-template-columns:\s*minmax\(7rem,\s*auto\)\s+minmax\(0,\s*1fr\)/);
  assert.match(styles, /\.category-dashboard-grid \{[^}]*grid-template-columns:\s*repeat\(var\(--category-count\),\s*minmax\(0,\s*1fr\)\)/);
  assert.match(styles, /\.category-comparison__name \{[^}]*white-space:\s*nowrap/);
  assert.doesNotMatch(styles, /\.category-dashboard-grid, \.classification-progress-grid \{ grid-template-columns:\s*1fr/);
});

test("延迟筛选只使用查询按钮提交且不显示待查询提示", async () => {
  const common = await source("apps/web/src/components/common.tsx");

  assert.match(common, /deferred \? <button className="button button--primary"[^>]*>查询<\/button>/);
  assert.doesNotMatch(common, /筛选条件尚未查询|filter-bar__pending|hasPendingChanges/);
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
  assert.match(styles, /\.category-dashboard-grid \{[^}]*repeat\(var\(--category-count\),\s*minmax\(0,\s*1fr\)\)/);
  assert.match(styles, /\.content-table \{[^}]*table-layout:\s*fixed/);
  assert.match(styles, /\.content-table \{ min-width:\s*62rem/);
  assert.match(styles, /\.trend-visual \{[^}]*overflow:\s*hidden/);
  assert.match(styles, /\.trend-visual svg \{[^}]*min-width:\s*0/);
  assert.match(styles, /\.trend-axis \{[^}]*min-width:\s*0/);
  assert.doesNotMatch(styles, /trend-scroll-hint/);
  assert.match(mobileBlock, /\.simulation-banner span \{ display: none; \}/);
});

test("内容明细使用帖子评论双列表并固定每页十条", async () => {
  const [content, styles] = await Promise.all([
    source("apps/web/src/pages/content.tsx"),
    source("apps/web/src/styles.css")
  ]);

  assert.match(content, /value\.set\("pageSize", "10"\)/);
  assert.match(content, />帖子库<\/button>/);
  assert.match(content, />评论库<\/button>/);
  assert.doesNotMatch(content, /<PageHeader/);
  assert.match(content, /showDate=\{contentType !== "COMMENT"\} sticky/);
  assert.match(content, /className="content-table"/);
  assert.match(content, /<th className="content-table__content">内容<\/th>/);
  assert.match(content, /共\{pagination\.totalItems\}条，每页10条/);
  assert.match(content, /visiblePages\(pagination\.page, pagination\.totalPages\)/);
  assert.doesNotMatch(content, /className="content-preview"/);
  assert.match(styles, /\.content-table__content \{ width:\s*49%; \}/);
  assert.match(styles, /\.content-table__actions \{ width:\s*12%; \}/);
  assert.match(styles, /\.sidebar nav a\[href="\/data-management"\] \{ display:\s*none; \}/);
  assert.match(styles, /\.app-shell:not\(\.is-overview\) \.filter-bar\.is-sticky \{ top:\s*var\(--topbar-height\); \}/);
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

test("概览合同在滚动发布期间把旧版热榜计数字段视为暂缺", async () => {
  const overview = JSON.parse(await source("fixtures/web-api/overview.json")) as {
    risingTopics: Array<Record<string, unknown>>;
  };
  delete overview.risingTopics[0]?.affectedPostCount;
  delete overview.risingTopics[0]?.commentCount;

  const parsed = OverviewDataSchema.parse(overview);

  assert.equal(parsed.risingTopics[0]?.affectedPostCount, null);
  assert.equal(parsed.risingTopics[0]?.commentCount, null);
});

test("本地开发代理从仓库根目录读取配置且不硬编码目标地址", async () => {
  const viteConfig = await source("apps/web/vite.config.ts");

  assert.match(viteConfig, /new URL\("\.\.\/\.\.\/", import\.meta\.url\)/);
  assert.match(viteConfig, /loadEnv\(mode, repositoryRoot, ""\)/);
  assert.match(viteConfig, /READTRACE_API_PROXY_TARGET/);
  assert.doesNotMatch(viteConfig, /target:\s*["']https?:\/\//);
});

test("登录页只把明确的鉴权失败提示为账号或密码错误", async () => {
  const loginPage = await source("apps/web/src/pages/login.tsx");

  assert.match(loginPage, /reason\.code === "AUTH_FAILED"/);
  assert.match(loginPage, /账号和密码尚未完成校验/);
  assert.match(loginPage, /<p>\{error\}<\/p>/);
  assert.doesNotMatch(loginPage, /<p>账号或密码不正确，或当前账号暂时无法登录。<\/p>/);
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
