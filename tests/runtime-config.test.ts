import assert from "node:assert/strict";
import test from "node:test";
import { loadRuntimeConfig } from "../apps/api/src/config.js";

const liveBase = {
  DATA_MODE: "mysql",
  ADMIN_USERNAME: "readtrace-admin",
  ADMIN_PASSWORD: "strong-password-2026"
} as NodeJS.ProcessEnv;

test("正式模式强制使用安全Cookie", () => {
  assert.equal(loadRuntimeConfig(liveBase).sessionCookieSecure, true);
  assert.throws(
    () => loadRuntimeConfig({ ...liveBase, SESSION_COOKIE_SECURE: "false" }),
    /runtime_config_invalid/
  );
});

test("正式模式只要求管理员密码至少八位", () => {
  assert.throws(
    () => loadRuntimeConfig({ ...liveBase, ADMIN_PASSWORD: "1234567" }),
    /runtime_config_invalid/
  );
  assert.equal(
    loadRuntimeConfig({ ...liveBase, ADMIN_PASSWORD: "abcdefgh" }).adminPassword,
    "abcdefgh"
  );
});

test("模拟模式保留本地默认登录配置", () => {
  const config = loadRuntimeConfig({ DATA_MODE: "mock" });
  assert.equal(config.adminUsername, "admin");
  assert.equal(config.adminPassword, "readtrace-demo");
  assert.equal(config.sessionCookieSecure, false);
});
