import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ZodError, z } from "zod";
import {
  BrandCreateInputSchema,
  BrandPatchInputSchema,
  BrandSearchTermsInputSchema,
  CollectionCredentialInputSchema,
  CollectionRunCreateInputSchema,
  ContentListQuerySchema,
  ContentTypeSchema,
  CorrectionInputSchema,
  CredentialKindSchema,
  LoginInputSchema,
  ManualCollectionInputSchema,
  PageQuerySchema,
  RiskLevelSchema,
  SentimentSchema,
  type DataMode,
  type ErrorCode
} from "@readtrace/contracts";
import type { RuntimeConfig } from "./config.js";
import { MockRepository } from "./repositories/mock.js";
import type { DataRepository, ListOptions, Page } from "./repositories/types.js";
import { RepositoryError, notImplemented } from "./repositories/types.js";

const MOCK_SESSION_COOKIE = "readtrace_session";
const LIVE_SESSION_COOKIE = "__Host-readtrace_session";
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const API_ROOT = "/api/v1";

interface RuntimeRepository extends DataRepository { fixtureVersion?: string }
interface Session { expiresAt: number }

function commaSeparated(value: string | undefined, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value.split(",").map((item) => item.trim());
  if (items.length === 0 || items.some((item) => item.length === 0)) {
    throw new RepositoryError("VALIDATION_ERROR", 400, false, `${field}包含空值。`);
  }
  return [...new Set(items)];
}

function secureEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function rejectRouteFilters(options: ListOptions, allowed: Array<keyof ListOptions>): void {
  const accepted = new Set<keyof ListOptions>(["page", "pageSize", "sortOrder", ...allowed]);
  const unsupported = (Object.keys(options) as Array<keyof ListOptions>)
    .filter((key) => !accepted.has(key) && options[key] !== undefined);
  if (unsupported.length) {
    throw new RepositoryError("VALIDATION_ERROR", 400, false, `当前端点不支持筛选字段：${unsupported.join(",")}。`);
  }
}

function parsePage(query: unknown): ListOptions {
  const source = z.object({
    page: z.unknown().optional(),
    pageSize: z.unknown().optional(),
    sortOrder: z.unknown().optional(),
    keyword: z.string().min(1).optional(),
    contentType: ContentTypeSchema.optional(),
    status: z.string().min(1).optional(),
    statuses: z.string().min(1).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    brandIds: z.string().min(1).optional(),
    sentiment: z.string().min(1).optional(),
    sentiments: z.string().min(1).optional(),
    categoryIds: z.string().min(1).optional(),
    problemTypeIds: z.string().min(1).optional(),
    topicId: z.string().min(1).optional(),
    topicIds: z.string().min(1).optional(),
    contentNature: z.string().min(1).optional(),
    contentNatures: z.string().min(1).optional(),
    riskLevels: z.string().min(1).optional(),
    productSeries: z.string().min(1).optional(),
    productModel: z.string().min(1).optional(),
    classificationType: z.enum(["CATEGORY", "PROBLEM_TYPE", "TOPIC"]).optional(),
    isEnabled: z.enum(["true", "false"]).optional()
  }).parse(query);
  if (source.from && source.to && Date.parse(source.from) > Date.parse(source.to)) {
    throw new RepositoryError("VALIDATION_ERROR", 400, false, "from不能晚于to。");
  }
  const pagination = PageQuerySchema.parse(source);
  const statuses = commaSeparated(source.statuses, "statuses");
  const brandIds = commaSeparated(source.brandIds, "brandIds");
  const sentimentValues = commaSeparated(source.sentiments ?? source.sentiment, "sentiments");
  const categoryIds = commaSeparated(source.categoryIds, "categoryIds");
  const problemTypeIds = commaSeparated(source.problemTypeIds, "problemTypeIds");
  const topicIds = commaSeparated(source.topicIds ?? source.topicId, "topicIds");
  const contentNatures = commaSeparated(source.contentNatures ?? source.contentNature, "contentNatures");
  const riskValues = commaSeparated(source.riskLevels, "riskLevels");
  return {
    page: pagination.page,
    pageSize: pagination.pageSize as ListOptions["pageSize"],
    sortOrder: pagination.sortOrder,
    ...(source.keyword === undefined ? {} : { keyword: source.keyword }),
    ...(source.contentType === undefined ? {} : { contentType: source.contentType }),
    ...(source.status === undefined ? {} : { status: source.status }),
    ...(statuses === undefined ? {} : { statuses }),
    ...(source.from === undefined ? {} : { from: source.from }),
    ...(source.to === undefined ? {} : { to: source.to }),
    ...(brandIds === undefined ? {} : { brandIds }),
    ...(sentimentValues === undefined ? {} : { sentiments: sentimentValues.map((value) => SentimentSchema.parse(value)) }),
    ...(categoryIds === undefined ? {} : { categoryIds }),
    ...(problemTypeIds === undefined ? {} : { problemTypeIds }),
    ...(topicIds === undefined ? {} : { topicIds }),
    ...(contentNatures === undefined ? {} : { contentNatures }),
    ...(riskValues === undefined ? {} : { riskLevels: riskValues.map((value) => RiskLevelSchema.parse(value)) }),
    ...(source.productSeries === undefined ? {} : { productSeries: source.productSeries }),
    ...(source.productModel === undefined ? {} : { productModel: source.productModel }),
    ...(source.classificationType === undefined ? {} : { classificationType: source.classificationType }),
    ...(source.isEnabled === undefined ? {} : { isEnabled: source.isEnabled === "true" })
  };
}

function parseVersion(request: FastifyRequest): number {
  const raw = request.headers["if-match"];
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new RepositoryError("VALIDATION_ERROR", 400, false, "If-Match必须提供有效版本号。");
  }
  return Number(raw);
}

export async function createServer(config: RuntimeConfig): Promise<FastifyInstance> {
  const repository: RuntimeRepository = config.dataMode === "mock"
    ? await MockRepository.create()
    : await (await import("./repositories/mysql.js")).createMysqlRepository();
  const dataMode: DataMode = config.dataMode === "mock" ? "MOCK" : "LIVE";
  const sessionCookieName = config.dataMode === "mysql" ? LIVE_SESSION_COOKIE : MOCK_SESSION_COOKIE;
  const sessions = new Map<string, Session>();
  const app = Fastify({
    disableRequestLogging: true,
    logger: { level: "info", redact: ["req.headers.cookie", "req.headers.authorization", "res.headers.set-cookie"] }
  });
  await app.register(cookie);

  const meta = (requestId: string, pagination?: Page<unknown>, collectionStatus?: {
    lastSuccessfulCollectionAt: string | null;
    consecutiveFailureCount: number;
    volumeAnomaly: boolean;
  }) => ({
    requestId,
    generatedAt: new Date().toISOString(),
    dataMode,
    persistence: config.dataMode === "mock" ? "EPHEMERAL" as const : "PERSISTED" as const,
    ...(repository.fixtureVersion === undefined ? {} : { fixtureVersion: repository.fixtureVersion }),
    ...(pagination === undefined ? {} : {
      pagination: {
        page: pagination.page,
        pageSize: pagination.pageSize,
        totalItems: pagination.totalItems,
        totalPages: Math.ceil(pagination.totalItems / pagination.pageSize)
      }
    }),
    ...(collectionStatus === undefined ? {} : collectionStatus)
  });
  const ok = (request: FastifyRequest, data: unknown, pagination?: Page<unknown>, collectionStatus?: {
    lastSuccessfulCollectionAt: string | null;
    consecutiveFailureCount: number;
    volumeAnomaly: boolean;
  }) => ({ data, meta: meta(request.id, pagination, collectionStatus) });

  app.addHook("onClose", async () => repository.close());
  app.addHook("preHandler", async (request) => {
    if (!request.url.startsWith(`${API_ROOT}/`) || request.url.startsWith(`${API_ROOT}/session`)) return;
    const token = request.cookies[sessionCookieName];
    const session = token ? sessions.get(token) : undefined;
    if (!session || session.expiresAt <= Date.now()) {
      if (token) sessions.delete(token);
      throw new RepositoryError("AUTH_REQUIRED", 401, false, "请先登录。");
    }
  });

  app.setErrorHandler((error, request, reply) => {
    let code: ErrorCode = "INTERNAL_ERROR";
    let statusCode = 500;
    let retryable = false;
    let message = "服务暂时无法处理请求。";
    let fieldErrors: Array<{ field: string; code: string }> | undefined;
    if (error instanceof RepositoryError) {
      ({ code, statusCode, retryable, message } = error);
    } else if (error instanceof ZodError) {
      code = "VALIDATION_ERROR";
      statusCode = 400;
      message = "请求参数不符合要求。";
      fieldErrors = error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code }));
    }
    const failure = {
      error: { code, message, retryable, ...(fieldErrors === undefined ? {} : { fieldErrors }) },
      meta: meta(request.id)
    };
    void reply.status(statusCode).send(failure);
  });

  app.post(`${API_ROOT}/session`, async (request, reply) => {
    const credentials = LoginInputSchema.parse(request.body);
    const usernameMatches = secureEqual(credentials.username, config.adminUsername);
    const passwordMatches = secureEqual(credentials.password, config.adminPassword);
    const authenticated = usernameMatches && passwordMatches;
    if (!authenticated) throw new RepositoryError("AUTH_FAILED", 401, false, "账号或密码错误。");
    const token = randomUUID();
    const expiresAt = Date.now() + SESSION_LIFETIME_MS;
    sessions.set(token, { expiresAt });
    reply.setCookie(sessionCookieName, token, {
      httpOnly: true, sameSite: "strict", secure: config.sessionCookieSecure, path: "/", expires: new Date(expiresAt)
    });
    return ok(request, { isAuthenticated: true, expiresAt: new Date(expiresAt).toISOString() });
  });
  app.get(`${API_ROOT}/session`, async (request) => {
    const token = request.cookies[sessionCookieName];
    const session = token ? sessions.get(token) : undefined;
    const active = Boolean(session && session.expiresAt > Date.now());
    return ok(request, { isAuthenticated: active, expiresAt: active ? new Date(session!.expiresAt).toISOString() : null });
  });
  app.delete(`${API_ROOT}/session`, async (request, reply) => {
    const token = request.cookies[sessionCookieName];
    if (token) sessions.delete(token);
    reply.clearCookie(sessionCookieName, {
      path: "/", secure: config.sessionCookieSecure, sameSite: "strict"
    });
    return ok(request, { isAuthenticated: false });
  });

  app.get(`${API_ROOT}/overview`, async (request) => {
    const options = parsePage(request.query);
    rejectRouteFilters(options, ["from", "to", "brandIds", "categoryIds"]);
    return ok(request, await repository.getOverview(options));
  });
  app.get(`${API_ROOT}/data-management/summary`, async (request) => {
    return ok(request, await repository.getDataManagementSummary());
  });
  app.post(`${API_ROOT}/analysis-runs`, async (request, reply) => {
    if (config.dataMode !== "mysql") {
      throw new RepositoryError("DATA_NOT_READY", 503, false, "自动分析只在持久化数据模式下可用。");
    }
    let context: Awaited<ReturnType<typeof import("../../../src/db/pool.js").createDatabaseContext>> | undefined;
    try {
      const [{ createDatabaseContext }, { loadDeepSeekConfigForPool }, { safeRunSummary, startUnifiedAnalysis }] = await Promise.all([
        import("../../../src/db/pool.js"),
        import("../../../src/analysis/config.js"),
        import("../../../src/analysis/run-all.js")
      ]);
      context = await createDatabaseContext();
      const analysisConfig = await loadDeepSeekConfigForPool(context.pool);
      const run = await startUnifiedAnalysis({ pool: context.pool, config: analysisConfig, source: "manual" });
      if (!run.started) {
        await context.pool.end();
        return reply.status(202).send(ok(request, { started: false, reason: "already_running" }));
      }
      const activeContext = context;
      void run.completion!.then((summary) => {
        app.log.info({ analysis: safeRunSummary(summary) }, "analysis_run_completed");
      }).catch(() => {
        app.log.error({ errorCode: "analysis_failed", source: "manual" }, "analysis_run_failed");
      }).finally(async () => {
        await activeContext.pool.end().catch(() => undefined);
      });
      return reply.status(202).send(ok(request, { started: true }));
    } catch {
      await context?.pool.end().catch(() => undefined);
      throw new RepositoryError("DEPENDENCY_UNAVAILABLE", 503, true, "分析服务暂时不可用，请稍后重试。");
    }
  });
  app.get(`${API_ROOT}/topics`, async (request) => {
    const options = parsePage(request.query);
    rejectRouteFilters(options, ["from", "to", "brandIds", "categoryIds", "problemTypeIds", "sentiments", "topicIds"]);
    const result = await repository.listTopics(options);
    return ok(request, result.items, result);
  });
  app.get(`${API_ROOT}/keywords`, async (request) => {
    const options = parsePage(request.query);
    rejectRouteFilters(options, ["from", "to", "brandIds", "categoryIds", "problemTypeIds", "sentiments", "topicIds"]);
    const result = await repository.listKeywords(options);
    return ok(request, result.items, result);
  });
  app.get(`${API_ROOT}/topics/:topicId/evidence`, async (request) => {
    const { topicId } = z.object({ topicId: z.string().min(1) }).parse(request.params);
    const options = parsePage(request.query);
    rejectRouteFilters(options, ["contentType", "from", "to", "brandIds", "categoryIds"]);
    const result = await repository.listTopicEvidence(topicId, options);
    return ok(request, result.items, result);
  });
  app.get(`${API_ROOT}/contents`, async (request) => {
    ContentListQuerySchema.parse(request.query);
    const options = parsePage(request.query);
    rejectRouteFilters(options, [
      "contentType", "keyword", "from", "to", "brandIds", "sentiments", "categoryIds", "problemTypeIds",
      "topicIds", "contentNatures", "riskLevels", "productSeries", "productModel"
    ]);
    const result = await repository.listContents(options);
    return ok(request, result.items, result);
  });
  app.get(`${API_ROOT}/contents/:contentType/:contentId`, async (request) => {
    const params = z.object({ contentType: ContentTypeSchema, contentId: z.string().min(1) }).parse(request.params);
    return ok(request, await repository.getContent(params.contentType, params.contentId));
  });
  app.patch(`${API_ROOT}/contents/:contentType/:contentId/correction`, async (request) => {
    const params = z.object({ contentType: ContentTypeSchema, contentId: z.string().min(1) }).parse(request.params);
    return ok(request, await repository.updateCorrection(params.contentType, params.contentId, parseVersion(request), CorrectionInputSchema.parse(request.body)));
  });
  app.delete(`${API_ROOT}/contents/:contentType/:contentId/correction`, async (request) => {
    const params = z.object({ contentType: ContentTypeSchema, contentId: z.string().min(1) }).parse(request.params);
    return ok(request, await repository.deleteCorrection(params.contentType, params.contentId, parseVersion(request)));
  });
  app.post(`${API_ROOT}/exports`, async () => notImplemented());
  app.get(`${API_ROOT}/exports/:exportId`, async () => notImplemented());

  app.get(`${API_ROOT}/brands`, async (request) => {
    const options = parsePage(request.query);
    rejectRouteFilters(options, ["status", "keyword", "brandIds"]);
    const result = await repository.listBrands(options);
    return ok(request, result.items, result);
  });
  app.post(`${API_ROOT}/brands`, async (request, reply) => {
    const brand = await repository.createBrand(BrandCreateInputSchema.parse(request.body));
    return reply.status(201).send(ok(request, brand));
  });
  app.patch(`${API_ROOT}/brands/:brandId`, async (request) => {
    const { brandId } = z.object({ brandId: z.string().min(1) }).parse(request.params);
    return ok(request, await repository.updateBrand(brandId, parseVersion(request), BrandPatchInputSchema.parse(request.body)));
  });
  app.put(`${API_ROOT}/brands/:brandId/searchTerms`, async (request) => {
    const { brandId } = z.object({ brandId: z.string().min(1) }).parse(request.params);
    const input = BrandSearchTermsInputSchema.parse(request.body);
    return ok(request, await repository.updateBrand(brandId, parseVersion(request), input));
  });
  app.post(`${API_ROOT}/brands/:brandId/collection-runs`, async (request, reply) => {
    const { brandId } = z.object({ brandId: z.string().min(1) }).parse(request.params);
    ManualCollectionInputSchema.parse(request.body);
    return reply.status(202).send(ok(request, await repository.startManualCollection(brandId)));
  });
  app.get(`${API_ROOT}/service-credentials`, async (request) => {
    return ok(request, await repository.listServiceCredentials());
  });
  app.put(`${API_ROOT}/service-credentials/:kind`, async (request) => {
    const { kind } = z.object({ kind: CredentialKindSchema }).parse(request.params);
    const { secret } = CollectionCredentialInputSchema.parse(request.body);
    return ok(request, await repository.saveServiceCredential(kind, secret));
  });
  app.delete(`${API_ROOT}/service-credentials/:kind`, async (request) => {
    const { kind } = z.object({ kind: CredentialKindSchema }).parse(request.params);
    return ok(request, await repository.deleteServiceCredential(kind));
  });
  app.get(`${API_ROOT}/classifications`, async (request) => {
    const options = parsePage(request.query);
    rejectRouteFilters(options, ["classificationType", "isEnabled"]);
    const result = await repository.listClassifications(options);
    return ok(request, result.items, result);
  });
  app.post(`${API_ROOT}/classifications`, async () => notImplemented());
  app.patch(`${API_ROOT}/classifications/:classificationId`, async () => notImplemented());
  app.get(`${API_ROOT}/collection-runs`, async (request) => {
    const options = parsePage(request.query);
    rejectRouteFilters(options, ["status", "statuses", "brandIds", "from", "to"]);
    const result = await repository.listCollectionRuns(options);
    return ok(request, result.items, result, {
      lastSuccessfulCollectionAt: result.lastSuccessfulCollectionAt,
      consecutiveFailureCount: result.consecutiveFailureCount,
      volumeAnomaly: result.volumeAnomaly
    });
  });
  app.post(`${API_ROOT}/collection-runs`, async (request, reply) => {
    const input = CollectionRunCreateInputSchema.parse(request.body);
    return reply.status(202).send(ok(request, await repository.startCollection(input)));
  });
  app.post(`${API_ROOT}/collection-runs/:taskId/stop`, async (request, reply) => {
    const { taskId } = z.object({ taskId: z.string().min(1) }).parse(request.params);
    return reply.status(202).send(ok(request, await repository.stopCollection(taskId)));
  });
  app.post(`${API_ROOT}/collection-runs/:taskId/retries`, async (request, reply) => {
    const { taskId } = z.object({ taskId: z.string().min(1) }).parse(request.params);
    return reply.status(202).send(ok(request, await repository.retryCollectionRun(taskId)));
  });

  return app;
}
