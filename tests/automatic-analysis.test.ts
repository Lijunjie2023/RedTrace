import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("统一分析入口依次处理帖子和评论并使用全局锁", async () => {
  const source = await readFile("src/analysis/run-all.ts", "utf8");
  assert.match(source, /GET_LOCK/);
  assert.match(source, /RELEASE_LOCK/);
  assert.ok(source.indexOf('"POST"') < source.indexOf('"COMMENT"'));
  assert.match(source, /already_running/);
  assert.doesNotMatch(source, /console\.(?:log|error)\([^\n]*(?:candidate|messages|apiKey|Authorization)/);
});

test("管理员接口能够异步触发统一分析", async () => {
  const [server, client, page] = await Promise.all([
    readFile("apps/api/src/server.ts", "utf8"),
    readFile("apps/web/src/api/client.ts", "utf8"),
    readFile("apps/web/src/pages/data-management.tsx", "utf8")
  ]);
  assert.match(server, /\/analysis-runs/);
  assert.match(server, /status\(202\)/);
  assert.match(client, /triggerAnalysis/);
  assert.match(page, /立即分析/);
  assert.match(page, /正在启动/);
  assert.match(page, /当前已有分析任务正在运行/);
});

test("systemd每30分钟运行统一分析且支持错过后补触发", async () => {
  const [service, timer] = await Promise.all([
    readFile("deploy/systemd/readtrace-analysis.service", "utf8"),
    readFile("deploy/systemd/readtrace-analysis.timer", "utf8")
  ]);
  assert.match(service, /^User=readtrace$/m);
  assert.match(service, /^EnvironmentFile=\/etc\/readtrace\/readtrace\.env$/m);
  assert.match(service, /analyze:all/);
  assert.match(timer, /^OnBootSec=5min$/m);
  assert.match(timer, /^OnUnitActiveSec=30min$/m);
  assert.match(timer, /^Persistent=true$/m);
});
