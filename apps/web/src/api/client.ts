import {
  ApiFailureSchema,
  BrandCreateInputSchema,
  BrandSchema,
  ClassificationItemSchema,
  CollectionTaskSummarySchema,
  ContentDetailSchema,
  ContentSummarySchema,
  EffectiveAnalysisSchema,
  EvidenceRefSchema,
  KeywordSchema,
  OverviewDataSchema,
  ResponseMetaSchema,
  TopicSchema,
  apiSuccessSchema,
  type Brand,
  type ClassificationItem,
  type CollectionTaskSummary,
  type ContentDetail,
  type ContentSummary,
  type EffectiveAnalysis,
  type Keyword,
  type OverviewData,
  type Topic
} from "@readtrace/contracts";
import { z } from "zod";
import { publishMeta, type ResponseMeta } from "./meta-store";

const API_ROOT = "/api/v1";

type ApiSuccess<T> = { data: T; meta: ResponseMeta };
type Pagination = NonNullable<ResponseMeta["pagination"]>;
type Paginated<T> = { items: T[]; pagination: Pagination };
type Evidence = ContentDetail["context"][number];
type BrandCreateInput = ReturnType<typeof BrandCreateInputSchema.parse>;

const SessionSchema = z.object({ isAuthenticated: z.boolean(), expiresAt: z.string().datetime().nullable().optional() });
const TopicPageSchema = z.union([z.array(TopicSchema), z.object({ items: z.array(TopicSchema), analysisStatus: z.enum(["AVAILABLE", "NOT_AVAILABLE"]).optional() })]);
const KeywordPageSchema = z.union([z.array(KeywordSchema), z.object({ items: z.array(KeywordSchema), analysisStatus: z.enum(["AVAILABLE", "NOT_AVAILABLE"]).optional() })]);
const ContentPageSchema = z.union([z.array(ContentSummarySchema), z.object({ items: z.array(ContentSummarySchema) })]);
const EvidencePageSchema = z.union([z.array(EvidenceRefSchema), z.object({ items: z.array(EvidenceRefSchema) })]);
const BrandPageSchema = z.union([z.array(BrandSchema), z.object({ items: z.array(BrandSchema) })]);
const ClassificationPageSchema = z.union([z.array(ClassificationItemSchema), z.object({ items: z.array(ClassificationItemSchema) })]);
const TaskPageSchema = z.array(CollectionTaskSummarySchema);

export class ApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId: string;
  readonly status: number;

  constructor(status: number, failure: ReturnType<typeof ApiFailureSchema.parse>) {
    super(failure.error.message);
    this.name = "ApiError";
    this.code = failure.error.code;
    this.retryable = failure.error.retryable;
    this.requestId = failure.meta.requestId;
    this.status = status;
  }
}

export class ContractError extends Error {
  readonly requestId: string | null;

  constructor(requestId: string | null) {
    super("接口返回的数据格式不符合约定");
    this.name = "ContractError";
    this.requestId = requestId;
  }
}

function queryString(params: URLSearchParams | Record<string, string | number | undefined>): string {
  const search = params instanceof URLSearchParams ? new URLSearchParams(params) : new URLSearchParams();
  if (!(params instanceof URLSearchParams)) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== "") search.set(key, String(value));
    });
  }
  const value = search.toString();
  return value ? `?${value}` : "";
}

async function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<ApiSuccess<T>> {
  const response = await fetch(`${API_ROOT}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init
  });
  const raw: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsedFailure = ApiFailureSchema.safeParse(raw);
    if (!parsedFailure.success) throw new ContractError(null);
    publishMeta(parsedFailure.data.meta);
    if (parsedFailure.data.error.code === "AUTH_REQUIRED") window.dispatchEvent(new Event("readtrace:auth-required"));
    throw new ApiError(response.status, parsedFailure.data);
  }

  const parsed = apiSuccessSchema(schema).safeParse(raw);
  if (!parsed.success) {
    const parsedMeta = ResponseMetaSchema.safeParse((raw as { meta?: unknown } | null)?.meta);
    const requestId = parsedMeta.success ? parsedMeta.data.requestId : null;
    throw new ContractError(requestId);
  }
  const envelope = parsed.data as ApiSuccess<T>;
  publishMeta(envelope.meta);
  return envelope;
}

function asPage<T>(response: ApiSuccess<T[] | { items: T[] }>): Paginated<T> {
  if (!response.meta.pagination) throw new ContractError(response.meta.requestId);
  return { items: Array.isArray(response.data) ? response.data : response.data.items, pagination: response.meta.pagination };
}

export const api = {
  getSession: () => request("/session", SessionSchema),
  login: (username: string, password: string) => request("/session", SessionSchema, {
    method: "POST",
    body: JSON.stringify({ username, password })
  }),
  logout: () => request("/session", SessionSchema, { method: "DELETE" }),
  getOverview: (search: URLSearchParams) => request(`/overview${queryString(search)}`, OverviewDataSchema),
  getTopics: async (search: URLSearchParams): Promise<Paginated<Topic> & { analysisStatus?: string }> => {
    const response = await request(`/topics${queryString(search)}`, TopicPageSchema);
    return { ...asPage(response), analysisStatus: Array.isArray(response.data) ? undefined : response.data.analysisStatus };
  },
  getKeywords: async (search: URLSearchParams): Promise<Paginated<Keyword> & { analysisStatus?: string }> => {
    const response = await request(`/keywords${queryString(search)}`, KeywordPageSchema);
    return { ...asPage(response), analysisStatus: Array.isArray(response.data) ? undefined : response.data.analysisStatus };
  },
  getTopicEvidence: async (topicId: string): Promise<Paginated<Evidence>> => asPage(
    await request(`/topics/${encodeURIComponent(topicId)}/evidence?page=1&pageSize=20`, EvidencePageSchema)
  ),
  getContents: async (search: URLSearchParams): Promise<Paginated<ContentSummary>> => asPage(
    await request(`/contents${queryString(search)}`, ContentPageSchema)
  ),
  getContent: (contentType: string, id: string) => request(
    `/contents/${encodeURIComponent(contentType)}/${encodeURIComponent(id)}`,
    ContentDetailSchema
  ),
  correctContent: (contentType: string, id: string, version: number, correction: Partial<EffectiveAnalysis>) => request(
    `/contents/${encodeURIComponent(contentType)}/${encodeURIComponent(id)}/correction`,
    EffectiveAnalysisSchema,
    { method: "PATCH", headers: { "If-Match": String(version) }, body: JSON.stringify(correction) }
  ),
  removeCorrection: (contentType: string, id: string, version: number) => request(
    `/contents/${encodeURIComponent(contentType)}/${encodeURIComponent(id)}/correction`,
    EffectiveAnalysisSchema,
    { method: "DELETE", headers: { "If-Match": String(version) } }
  ),
  getBrands: async (search = new URLSearchParams("page=1&pageSize=50")): Promise<Paginated<Brand>> => asPage(
    await request(`/brands${queryString(search)}`, BrandPageSchema)
  ),
  createBrand: (input: BrandCreateInput) => request("/brands", BrandSchema, { method: "POST", body: JSON.stringify(input) }),
  updateBrand: (brand: Brand, patch: Partial<BrandCreateInput>) => request(`/brands/${encodeURIComponent(brand.id)}`, BrandSchema, {
    method: "PATCH", headers: { "If-Match": String(brand.version) }, body: JSON.stringify(patch)
  }),
  triggerCollection: (brandId: string) => request(`/brands/${encodeURIComponent(brandId)}/collection-runs`, CollectionTaskSummarySchema, {
    method: "POST", body: JSON.stringify({ triggerType: "MANUAL" })
  }),
  getClassifications: async (): Promise<Paginated<ClassificationItem>> => asPage(
    await request("/classifications?page=1&pageSize=100", ClassificationPageSchema)
  ),
  getTasks: async (search: URLSearchParams): Promise<Paginated<CollectionTaskSummary> & {
    lastSuccessfulCollectionAt: string | null | undefined;
    consecutiveFailureCount: number | undefined;
    volumeAnomaly: boolean | undefined;
  }> => {
    const response = await request(`/collection-runs${queryString(search)}`, TaskPageSchema);
    return {
      ...asPage(response),
      lastSuccessfulCollectionAt: response.meta.lastSuccessfulCollectionAt,
      consecutiveFailureCount: response.meta.consecutiveFailureCount,
      volumeAnomaly: response.meta.volumeAnomaly
    };
  },
  retryTask: (taskId: string) => request(`/collection-runs/${encodeURIComponent(taskId)}/retries`, CollectionTaskSummarySchema, {
    method: "POST", body: "{}"
  }),
  requestExport: (filters: URLSearchParams) => request("/exports", z.object({ exportId: z.string(), status: z.literal("QUEUED") }), {
    method: "POST", body: JSON.stringify(Object.fromEntries(filters))
  })
};

export type { Brand, BrandCreateInput, ClassificationItem, CollectionTaskSummary, ContentDetail, ContentSummary, EffectiveAnalysis, Keyword, OverviewData, Topic };
