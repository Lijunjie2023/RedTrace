import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseConfigError, toPoolOptions, validateDatabaseConfig } from "../src/db/config.js";
import { safeFailure } from "../src/db/errors.js";

function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MYSQL_HOST: "db.example.test",
    MYSQL_PORT: "3306",
    MYSQL_USER: "readtrace_app",
    MYSQL_PASSWORD: "local-test-password",
    MYSQL_DATABASE: "readtrace",
    MYSQL_SSL_MODE: "required",
    DB_CONNECTION_LIMIT: "5",
    ...overrides
  };
}

test("数据库配置保留密码原值并清理普通字段空白", () => {
  const password = "  p@ss # word  ";
  const config = validateDatabaseConfig(validEnv({
    MYSQL_HOST: "  db.example.test  ",
    MYSQL_USER: "  readtrace_app  ",
    MYSQL_PASSWORD: password,
    MYSQL_DATABASE: "  readtrace  ",
    MYSQL_SSL_MODE: "  REQUIRED  ",
    MYSQL_SSL_CA_FILE: "  C:\\certs\\ca.pem  ",
    MYSQL_PORT: " 3307 ",
    DB_CONNECTION_LIMIT: " 4 "
  }));

  assert.equal(config.password, password);
  assert.equal(config.host, "db.example.test");
  assert.equal(config.user, "readtrace_app");
  assert.equal(config.database, "readtrace");
  assert.equal(config.sslMode, "required");
  assert.equal(config.sslCaFile, "C:\\certs\\ca.pem");
  assert.equal(config.port, 3307);
  assert.equal(config.connectionLimit, 4);
});

test("数据库配置缺失时只指出字段名", () => {
  for (const field of ["MYSQL_HOST", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE"] as const) {
    const env = validEnv();
    delete env[field];
    assert.throws(
      () => validateDatabaseConfig(env),
      (error: unknown) => error instanceof DatabaseConfigError && error.field === field
    );
  }
});

test("端口和连接池只接受安全范围内的整数", () => {
  for (const port of ["0", "65536", "3306.5", "not-a-port", "-1"]) {
    assert.throws(
      () => validateDatabaseConfig(validEnv({ MYSQL_PORT: port })),
      (error: unknown) => error instanceof DatabaseConfigError && error.field === "MYSQL_PORT"
    );
  }
  for (const connectionLimit of ["0", "11", "2.5", "many", "-1"]) {
    assert.throws(
      () => validateDatabaseConfig(validEnv({ DB_CONNECTION_LIMIT: connectionLimit })),
      (error: unknown) => error instanceof DatabaseConfigError && error.field === "DB_CONNECTION_LIMIT"
    );
  }
  assert.equal(validateDatabaseConfig(validEnv({ MYSQL_PORT: "", DB_CONNECTION_LIMIT: "" })).port, 3306);
  assert.equal(validateDatabaseConfig(validEnv({ MYSQL_PORT: "", DB_CONNECTION_LIMIT: "" })).connectionLimit, 5);
});

test("SSL模式校验并映射为不泄露配置的连接选项", async () => {
  assert.throws(
    () => validateDatabaseConfig(validEnv({ MYSQL_SSL_MODE: "optional" })),
    (error: unknown) => error instanceof DatabaseConfigError && error.field === "MYSQL_SSL_MODE"
  );

  const requiredOptions = await toPoolOptions(validateDatabaseConfig(validEnv()));
  assert.deepEqual(requiredOptions.ssl, { rejectUnauthorized: true });

  const preferredOptions = await toPoolOptions(validateDatabaseConfig(validEnv({ MYSQL_SSL_MODE: "preferred" })));
  assert.deepEqual(preferredOptions.ssl, { rejectUnauthorized: false });

  const disabledOptions = await toPoolOptions(validateDatabaseConfig(validEnv({ MYSQL_SSL_MODE: "disabled" })));
  assert.equal(disabledOptions.ssl, undefined);
  assert.equal(disabledOptions.connectionLimit, 5);
  assert.equal(disabledOptions.timezone, "Z");
  assert.equal(disabledOptions.charset, "utf8mb4");
});

test("CA文件无法读取时只返回配置字段", async () => {
  const config = validateDatabaseConfig(validEnv({ MYSQL_SSL_CA_FILE: "Z:\\missing\\secret-ca.pem" }));
  await assert.rejects(
    () => toPoolOptions(config),
    (error: unknown) => error instanceof DatabaseConfigError && error.field === "MYSQL_SSL_CA_FILE"
  );
});

test("safeFailure不复制原始错误中的连接信息和凭据", () => {
  const original = {
    code: "ER_ACCESS_DENIED_ERROR",
    message: "Access denied for user real-user at real-host with password super-secret"
  };
  const failure = safeFailure(original);
  const output = JSON.stringify(failure);

  assert.deepEqual(failure, { ok: false, errorType: "authentication_failed" });
  for (const secret of ["real-user", "real-host", "super-secret", original.message]) {
    assert.equal(output.includes(secret), false);
  }
});
