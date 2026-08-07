import { z } from "zod";

export const DataModeSchema = z.enum(["MOCK", "LIVE"]);
export const PersistenceModeSchema = z.enum(["EPHEMERAL", "PERSISTED"]);
export const ContentTypeSchema = z.enum(["POST", "COMMENT"]);
export const SentimentSchema = z.enum(["POSITIVE", "NEUTRAL", "NEGATIVE", "UNKNOWN"]);
export const RiskLevelSchema = z.enum(["NORMAL", "WATCH", "HIGH_RISK"]);
export const ConfidenceLevelSchema = z.enum(["HIGH", "MEDIUM", "LOW"]);
export const BrandStatusSchema = z.enum(["DRAFT", "ENABLED", "DISABLED", "ARCHIVED"]);
export const SearchTermTypeSchema = z.enum(["ALIAS", "MODEL", "EXCLUDE"]);
export const SearchTermStatusSchema = z.enum(["ENABLED", "DISABLED", "ARCHIVED"]);
export const CollectionTaskStatusSchema = z.enum([
  "QUEUED",
  "RUNNING",
  "STOPPING",
  "STOPPED",
  "SUCCESS",
  "PARTIAL_SUCCESS",
  "FAILED"
]);
export const CredentialKindSchema = z.enum(["JUSTONEAPI", "DEEPSEEK"]);
export const CollectionHealthSchema = z.enum(["NOT_COLLECTED", "HEALTHY", "PARTIAL", "FAILED", "STALE"]);
export const EvidenceOriginSchema = z.enum(["ORIGINAL", "SIMULATED"]);
export const AnalysisOriginSchema = z.enum(["MODEL", "HUMAN_OVERRIDE", "SIMULATED", "UNAVAILABLE"]);
export const SortOrderSchema = z.enum(["ASC", "DESC"]);

export type DataMode = z.infer<typeof DataModeSchema>;
export type ContentType = z.infer<typeof ContentTypeSchema>;
export type CredentialKind = z.infer<typeof CredentialKindSchema>;

export const PaginationSchema = z.object({
  page: z.number().int().min(1),
  pageSize: z.union([z.literal(10), z.literal(20), z.literal(50), z.literal(100)]),
  totalItems: z.number().int().min(0),
  totalPages: z.number().int().min(0)
});

export const ResponseMetaSchema = z.object({
  requestId: z.string().min(1),
  generatedAt: z.string().datetime(),
  dataMode: DataModeSchema,
  persistence: PersistenceModeSchema,
  fixtureVersion: z.string().min(1).optional(),
  pagination: PaginationSchema.optional(),
  lastSuccessfulCollectionAt: z.string().datetime().nullable().optional(),
  consecutiveFailureCount: z.number().int().min(0).optional(),
  volumeAnomaly: z.boolean().optional()
});

export const ErrorCodeSchema = z.enum([
  "AUTH_REQUIRED",
  "AUTH_FAILED",
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "VERSION_CONFLICT",
  "DUPLICATE_RESOURCE",
  "COLLECTION_ALREADY_RUNNING",
  "DATA_NOT_READY",
  "DEPENDENCY_UNAVAILABLE",
  "NOT_IMPLEMENTED",
  "INTERNAL_ERROR"
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ApiFailureSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
    fieldErrors: z.array(z.object({ field: z.string().min(1), code: z.string().min(1) })).optional()
  }),
  meta: ResponseMetaSchema.omit({ pagination: true })
});

export function apiSuccessSchema<T extends z.ZodTypeAny>(data: T): z.ZodTypeAny {
  return z.object({ data, meta: ResponseMetaSchema });
}

export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().refine((value: number) => [10, 20, 50, 100].includes(value)).default(20),
  sortOrder: SortOrderSchema.default("DESC")
});

export const ContentListQuerySchema = PageQuerySchema.extend({ contentType: ContentTypeSchema });

export type PageQuery = z.infer<typeof PageQuerySchema>;

export const EffectiveAnalysisSchema = z.object({
  sentiment: SentimentSchema,
  contentNature: z.string().nullable(),
  problemTypeIds: z.array(z.string()),
  categoryId: z.string().nullable(),
  productSeries: z.string().nullable(),
  productModel: z.string().nullable(),
  userStage: z.string().nullable(),
  riskLevel: RiskLevelSchema,
  confidence: ConfidenceLevelSchema.nullable(),
  topicIds: z.array(z.string()),
  analysisOrigin: AnalysisOriginSchema,
  modelName: z.string().nullable(),
  analyzedAt: z.string().datetime().nullable(),
  correctedAt: z.string().datetime().nullable(),
  version: z.number().int().min(1)
});

export type EffectiveAnalysis = z.infer<typeof EffectiveAnalysisSchema>;

function isXiaohongshuUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "xiaohongshu.com" || url.hostname.endsWith(".xiaohongshu.com"));
  } catch {
    return false;
  }
}

export const ContentSummarySchema = z.object({
  id: z.string().min(1),
  contentType: ContentTypeSchema,
  postId: z.string().min(1),
  title: z.string().nullable(),
  excerpt: z.string().nullable(),
  authorDisplayName: z.string().nullable(),
  publishedAt: z.string().datetime().nullable(),
  likedCount: z.number().int().min(0).nullable(),
  collectedCount: z.number().int().min(0).nullable(),
  commentCount: z.number().int().min(0).nullable(),
  sourceUrl: z.string().url().nullable(),
  brandIds: z.array(z.string()),
  effectiveAnalysis: EffectiveAnalysisSchema,
  evidenceOrigin: EvidenceOriginSchema,
  canOpenOriginal: z.boolean(),
  firstCollectedAt: z.string().datetime().nullable(),
  lastCollectedAt: z.string().datetime().nullable()
}).superRefine((value, context) => {
  if (value.evidenceOrigin === "ORIGINAL") {
    if (value.sourceUrl === null || !isXiaohongshuUrl(value.sourceUrl)) {
      context.addIssue({ code: "custom", path: ["sourceUrl"], message: "原始证据必须提供小红书HTTPS链接。" });
    }
    if (!value.canOpenOriginal) {
      context.addIssue({ code: "custom", path: ["canOpenOriginal"], message: "原始证据必须允许打开来源。" });
    }
  } else if (value.sourceUrl !== null || value.canOpenOriginal) {
    context.addIssue({ code: "custom", path: ["sourceUrl"], message: "模拟证据不得提供可打开链接。" });
  }
});

export type ContentSummary = z.infer<typeof ContentSummarySchema>;

export const EvidenceRefSchema = z.object({
  contentType: ContentTypeSchema,
  contentId: z.string().min(1),
  evidenceOrigin: EvidenceOriginSchema,
  excerpt: z.string().nullable(),
  authorDisplayName: z.string().nullable(),
  publishedAt: z.string().datetime().nullable(),
  likedCount: z.number().int().min(0).nullable(),
  sourceUrl: z.string().url().nullable(),
  canOpenOriginal: z.boolean()
}).superRefine((value, context) => {
  if (value.evidenceOrigin === "ORIGINAL") {
    if (value.sourceUrl === null || !isXiaohongshuUrl(value.sourceUrl)) {
      context.addIssue({ code: "custom", path: ["sourceUrl"], message: "原始证据必须提供小红书HTTPS链接。" });
    }
    if (!value.canOpenOriginal) {
      context.addIssue({ code: "custom", path: ["canOpenOriginal"], message: "原始证据必须允许打开来源。" });
    }
  } else if (value.sourceUrl !== null || value.canOpenOriginal) {
    context.addIssue({ code: "custom", path: ["sourceUrl"], message: "模拟证据不得提供可打开链接。" });
  }
});

export const BrandSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: BrandStatusSchema,
  searchTerms: z.array(z.object({
    id: z.string().min(1),
    type: SearchTermTypeSchema,
    value: z.string().min(1),
    status: SearchTermStatusSchema
  })),
  lastSuccessfulCollectionAt: z.string().datetime().nullable(),
  latestTaskStatus: CollectionTaskStatusSchema.nullable(),
  version: z.number().int().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export type Brand = z.infer<typeof BrandSchema>;

export const ClassificationItemSchema = z.object({
  id: z.string().min(1),
  classificationType: z.enum(["CATEGORY", "PROBLEM_TYPE", "TOPIC"]),
  code: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().nullable(),
  isEnabled: z.boolean(),
  sortOrder: z.number().int().min(0),
  version: z.number().int().min(1)
});

export type ClassificationItem = z.infer<typeof ClassificationItemSchema>;

export const CollectionTaskSummarySchema = z.object({
  id: z.string().min(1),
  brandId: z.string().min(1),
  triggerType: z.enum(["MANUAL", "SCHEDULED", "RETRY"]),
  keyword: z.string().nullable(),
  noteLimit: z.number().int().min(1).max(10).nullable(),
  status: CollectionTaskStatusSchema,
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  succeededPostCount: z.number().int().min(0),
  failedPostCount: z.number().int().min(0),
  fetchedPostCount: z.number().int().min(0),
  fetchedCommentCount: z.number().int().min(0),
  storedPostCount: z.number().int().min(0),
  storedCommentCount: z.number().int().min(0),
  skippedNoCommentPostCount: z.number().int().min(0),
  failedCount: z.number().int().min(0),
  errorType: z.string().nullable(),
  errorSummary: z.string().nullable(),
  retryOfTaskId: z.string().nullable()
});

export type CollectionTaskSummary = z.infer<typeof CollectionTaskSummarySchema>;

export const ServiceCredentialSummarySchema = z.object({
  kind: CredentialKindSchema,
  configured: z.boolean(),
  lastFour: z.string().max(4).nullable(),
  updatedAt: z.string().datetime().nullable()
});

export type ServiceCredentialSummary = z.infer<typeof ServiceCredentialSummarySchema>;

export const CollectionStatusSummarySchema = z.object({
  lastSuccessfulCollectionAt: z.string().datetime().nullable(),
  consecutiveFailureCount: z.number().int().min(0),
  volumeAnomaly: z.boolean()
});

export type CollectionStatusSummary = z.infer<typeof CollectionStatusSummarySchema>;

export const OverviewDataSchema = z.object({
  metrics: z.object({
    postCount: z.number().int().min(0).nullable(),
    commentCount: z.number().int().min(0).nullable(),
    negativeCount: z.number().int().min(0).nullable(),
    negativeRatio: z.number().min(0).max(1).nullable()
  }),
  sentimentTrend: z.array(z.object({
    bucket: z.string(),
    positive: z.number().int().min(0),
    neutral: z.number().int().min(0),
    negative: z.number().int().min(0),
    unknown: z.number().int().min(0)
  })),
  brandRanking: z.array(z.object({ brandId: z.string(), brandName: z.string(), contentCount: z.number(), negativeCount: z.number() })),
  categoryRanking: z.array(z.object({ categoryId: z.string(), categoryName: z.string(), contentCount: z.number() })),
  problemTypeRanking: z.array(z.object({ problemTypeId: z.string(), problemTypeName: z.string(), contentCount: z.number() })),
  risingTopics: z.array(z.object({
    topicId: z.string(),
    topicName: z.string(),
    changeRatio: z.number().nullable(),
    evidenceCount: z.number().int().min(0),
    affectedPostCount: z.number().int().min(0).nullable().default(null),
    commentCount: z.number().int().min(0).nullable().default(null)
  })),
  highRiskContents: z.array(ContentSummarySchema),
  collectionHealth: CollectionHealthSchema,
  lastSuccessfulCollectionAt: z.string().datetime().nullable()
});

export type OverviewData = z.infer<typeof OverviewDataSchema>;

export const DataManagementSummarySchema = z.object({
  totalPosts: z.number().int().min(0),
  totalComments: z.number().int().min(0),
  aiClassifiedPosts: z.number().int().min(0),
  aiClassifiedComments: z.number().int().min(0),
  analysisRunningCount: z.number().int().min(0),
  analysisFailedCount: z.number().int().min(0),
  manualCorrectionCount: z.number().int().min(0),
  lastAnalysisAt: z.string().datetime().nullable()
});

export type DataManagementSummary = z.infer<typeof DataManagementSummarySchema>;

export const AnalysisRunTriggerSchema = z.object({
  started: z.boolean(),
  reason: z.literal("already_running").optional()
}).superRefine((value, context) => {
  if (value.started && value.reason !== undefined) {
    context.addIssue({ code: "custom", path: ["reason"], message: "已启动的任务不能包含跳过原因。" });
  }
  if (!value.started && value.reason !== "already_running") {
    context.addIssue({ code: "custom", path: ["reason"], message: "未启动的任务必须说明当前已有任务运行。" });
  }
});

export type AnalysisRunTrigger = z.infer<typeof AnalysisRunTriggerSchema>;

export const TopicSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  sentiment: SentimentSchema,
  contentCount: z.number().int().min(0),
  postCount: z.number().int().min(0),
  commentCount: z.number().int().min(0),
  userCount: z.number().int().min(0),
  likedCount: z.number().int().min(0),
  changeRatio: z.number().nullable(),
  evidenceCount: z.number().int().min(0),
  analysisOrigin: AnalysisOriginSchema
});

export type Topic = z.infer<typeof TopicSchema>;

export const KeywordSchema = z.object({
  keyword: z.string(),
  topicIds: z.array(z.string()),
  sentiment: SentimentSchema,
  occurrenceCount: z.number().int().min(0),
  postCount: z.number().int().min(0),
  commentCount: z.number().int().min(0),
  userCount: z.number().int().min(0),
  likedCount: z.number().int().min(0),
  changeRatio: z.number().nullable()
});

export type Keyword = z.infer<typeof KeywordSchema>;

export const ContentDetailSchema = ContentSummarySchema.extend({
  fullText: z.string().nullable(),
  parentCommentId: z.string().nullable(),
  context: z.array(EvidenceRefSchema),
  modelAnalysis: EffectiveAnalysisSchema.nullable()
});

export type ContentDetail = z.infer<typeof ContentDetailSchema>;

export const FixtureBundleSchema = z.object({
  overview: OverviewDataSchema,
  dataManagement: DataManagementSummarySchema,
  topics: z.array(TopicSchema),
  keywords: z.array(KeywordSchema),
  evidence: z.array(EvidenceRefSchema),
  contents: z.array(ContentDetailSchema),
  brands: z.array(BrandSchema),
  classifications: z.array(ClassificationItemSchema),
  collectionRuns: z.object({
    items: z.array(CollectionTaskSummarySchema),
    status: CollectionStatusSummarySchema
  })
});

export type FixtureBundle = z.infer<typeof FixtureBundleSchema>;

export const LoginInputSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });
export const CollectionCredentialInputSchema = z.object({
  secret: z.string().min(1).max(4096).refine((value) => value.trim().length > 0, {
    message: "凭证不能为空。"
  })
});
export const CollectionRunCreateInputSchema = z.object({
  brandId: z.string().min(1),
  keyword: z.string().trim().min(1).max(50),
  noteLimit: z.number().int().min(1).max(10)
});
export type CollectionCredentialInput = z.infer<typeof CollectionCredentialInputSchema>;
export type CollectionRunCreateInput = z.infer<typeof CollectionRunCreateInputSchema>;
export const ManualCollectionInputSchema = z.object({ triggerType: z.literal("MANUAL") });
export const BrandCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(191),
  status: BrandStatusSchema.default("DRAFT"),
  searchTerms: z.array(z.object({ type: SearchTermTypeSchema, value: z.string().trim().min(1).max(255) })).default([])
});
export const BrandPatchInputSchema = BrandCreateInputSchema.partial();
export const BrandSearchTermsInputSchema = BrandCreateInputSchema.pick({ searchTerms: true });
export const CorrectionInputSchema = EffectiveAnalysisSchema.pick({
  sentiment: true,
  contentNature: true,
  problemTypeIds: true,
  categoryId: true,
  productSeries: true,
  productModel: true,
  userStage: true,
  riskLevel: true,
  topicIds: true
}).partial().refine((value: Record<string, unknown>) => Object.keys(value).length > 0);
