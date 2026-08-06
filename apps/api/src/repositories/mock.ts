import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  FixtureBundleSchema,
  type Brand,
  type ClassificationItem,
  type CollectionTaskSummary,
  type ContentDetail,
  type ContentSummary,
  type EffectiveAnalysis,
  type FixtureBundle,
  type Keyword,
  type OverviewData,
  type Topic
} from "@readtrace/contracts";
import type { BrandCreateInput, CollectionRunPage, DataRepository, ListOptions, OptionalPatch, Page } from "./types.js";
import { RepositoryError, dataNotReady } from "./types.js";

interface Manifest {
  fixtureVersion: string;
  isSimulated: boolean;
}

async function readJson<T>(name: string): Promise<T> {
  const url = new URL(`../../../../fixtures/web-api/${name}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as T;
}

function paginate<T>(items: T[], options: ListOptions): Page<T> {
  const start = (options.page - 1) * options.pageSize;
  return {
    items: items.slice(start, start + options.pageSize),
    page: options.page,
    pageSize: options.pageSize,
    totalItems: items.length
  };
}

function withoutUndefined<T extends object>(input: OptionalPatch<T>): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function rejectUnsupportedOptions(options: ListOptions, allowed: Array<keyof ListOptions>, unavailable = false): void {
  const base = new Set<keyof ListOptions>(["page", "pageSize", "sortOrder", ...allowed]);
  const unsupported = (Object.keys(options) as Array<keyof ListOptions>)
    .filter((key) => !base.has(key) && options[key] !== undefined);
  if (unsupported.length === 0) return;
  if (unavailable) dataNotReady();
  throw new RepositoryError("VALIDATION_ERROR", 400, false, `当前资源不支持筛选字段：${unsupported.join(",")}。`);
}

export class MockRepository implements DataRepository {
  readonly fixtureVersion: string;
  private readonly overview: OverviewData;
  private readonly topics: Topic[];
  private readonly keywords: Keyword[];
  private readonly evidence: ContentDetail["context"];
  private readonly contents: ContentDetail[];
  private readonly brands: Brand[];
  private readonly classifications: ClassificationItem[];
  private readonly tasks: CollectionTaskSummary[];

  private constructor(manifest: Manifest, bundle: FixtureBundle) {
    this.fixtureVersion = manifest.fixtureVersion;
    this.overview = structuredClone(bundle.overview);
    this.topics = structuredClone(bundle.topics);
    this.keywords = structuredClone(bundle.keywords);
    this.evidence = structuredClone(bundle.evidence);
    this.contents = structuredClone(bundle.contents);
    this.brands = structuredClone(bundle.brands);
    this.classifications = structuredClone(bundle.classifications);
    this.tasks = structuredClone(bundle.collectionRuns.items);
  }

  static async create(): Promise<MockRepository> {
    const [manifest, overview, insights, contents, brands, classifications, collectionRuns] = await Promise.all([
      readJson<Manifest>("manifest.json"),
      readJson<unknown>("overview.json"),
      readJson<{ topics: unknown; keywords: unknown; evidence: unknown }>("insights.json"),
      readJson<unknown>("contents.json"),
      readJson<unknown>("brands.json"),
      readJson<unknown>("classifications.json"),
      readJson<unknown>("collection-runs.json")
    ]);
    if (!manifest.isSimulated || !manifest.fixtureVersion) throw new Error("fixture_manifest_invalid");
    const bundle = FixtureBundleSchema.parse({
      overview,
      topics: insights.topics,
      keywords: insights.keywords,
      evidence: insights.evidence,
      contents,
      brands,
      classifications,
      collectionRuns
    });
    return new MockRepository(manifest, bundle);
  }

  async close(): Promise<void> {}

  async getOverview(options: ListOptions): Promise<OverviewData> {
    rejectUnsupportedOptions(options, [], true);
    return structuredClone(this.overview);
  }

  async listTopics(options: ListOptions): Promise<Page<Topic>> {
    rejectUnsupportedOptions(options, ["sentiments", "topicIds"], true);
    const items = this.topics.filter((topic) => {
      if (options.sentiments && !options.sentiments.includes(topic.sentiment)) return false;
      if (options.topicIds && !options.topicIds.includes(topic.id)) return false;
      return true;
    });
    return paginate(structuredClone(items), options);
  }

  async listKeywords(options: ListOptions): Promise<Page<Keyword>> {
    rejectUnsupportedOptions(options, ["sentiments", "topicIds"], true);
    const items = this.keywords.filter((keyword) => {
      if (options.sentiments && !options.sentiments.includes(keyword.sentiment)) return false;
      if (options.topicIds && !options.topicIds.some((topicId) => keyword.topicIds.includes(topicId))) return false;
      return true;
    });
    return paginate(structuredClone(items), options);
  }

  async listTopicEvidence(topicId: string, options: ListOptions): Promise<Page<ContentDetail["context"][number]>> {
    rejectUnsupportedOptions(options, ["contentType", "keyword"]);
    if (!this.topics.some((topic) => topic.id === topicId)) {
      throw new RepositoryError("NOT_FOUND", 404, false, "原因主题不存在。");
    }
    const items = this.evidence.filter((evidence) => {
      if (options.contentType && evidence.contentType !== options.contentType) return false;
      if (options.keyword && !evidence.excerpt?.toLowerCase().includes(options.keyword.toLowerCase())) return false;
      return true;
    });
    return paginate(structuredClone(items), options);
  }

  async listContents(options: ListOptions): Promise<Page<ContentSummary>> {
    rejectUnsupportedOptions(options, [
      "contentType", "keyword", "from", "to", "brandIds", "sentiments", "categoryIds", "problemTypeIds",
      "topicIds", "contentNatures", "riskLevels", "productSeries", "productModel"
    ]);
    const keyword = options.keyword?.toLowerCase();
    const items = this.contents.filter((item) => {
      if (options.contentType && item.contentType !== options.contentType) return false;
      if (options.from && (!item.publishedAt || item.publishedAt < options.from)) return false;
      if (options.to && (!item.publishedAt || item.publishedAt > options.to)) return false;
      if (options.brandIds && !options.brandIds.some((brandId) => item.brandIds.includes(brandId))) return false;
      if (options.sentiments && !options.sentiments.includes(item.effectiveAnalysis.sentiment)) return false;
      if (options.categoryIds && (!item.effectiveAnalysis.categoryId || !options.categoryIds.includes(item.effectiveAnalysis.categoryId))) return false;
      if (options.problemTypeIds && !options.problemTypeIds.some((id) => item.effectiveAnalysis.problemTypeIds.includes(id))) return false;
      if (options.topicIds && !options.topicIds.some((id) => item.effectiveAnalysis.topicIds.includes(id))) return false;
      if (options.contentNatures && (!item.effectiveAnalysis.contentNature || !options.contentNatures.includes(item.effectiveAnalysis.contentNature))) return false;
      if (options.riskLevels && !options.riskLevels.includes(item.effectiveAnalysis.riskLevel)) return false;
      if (options.productSeries && item.effectiveAnalysis.productSeries !== options.productSeries) return false;
      if (options.productModel && item.effectiveAnalysis.productModel !== options.productModel) return false;
      if (!keyword) return true;
      return [item.title, item.excerpt, item.fullText].some((value) => value?.toLowerCase().includes(keyword));
    });
    return paginate(structuredClone(items), options);
  }

  async getContent(contentType: "POST" | "COMMENT", contentId: string): Promise<ContentDetail> {
    const item = this.contents.find((content) => content.contentType === contentType && content.id === contentId);
    if (!item) throw new RepositoryError("NOT_FOUND", 404, false, "内容不存在。");
    return structuredClone(item);
  }

  async listBrands(options: ListOptions): Promise<Page<Brand>> {
    rejectUnsupportedOptions(options, ["keyword", "status", "brandIds"]);
    const keyword = options.keyword?.toLowerCase();
    const items = this.brands.filter((brand) => {
      if (options.status && brand.status !== options.status) return false;
      if (options.brandIds && !options.brandIds.includes(brand.id)) return false;
      return !keyword || brand.name.toLowerCase().includes(keyword);
    });
    return paginate(structuredClone(items), options);
  }

  async createBrand(input: BrandCreateInput): Promise<Brand> {
    if (this.brands.some((brand) => brand.name.toLowerCase() === input.name.toLowerCase())) {
      throw new RepositoryError("DUPLICATE_RESOURCE", 409, false, "品牌名称已经存在。");
    }
    const now = new Date().toISOString();
    const id = `mock-brand-${randomUUID()}`;
    const brand: Brand = {
      id,
      name: input.name,
      status: input.status,
      searchTerms: input.searchTerms.map((term) => ({
        id: `mock-term-${randomUUID()}`,
        type: term.type,
        value: term.value,
        status: "ENABLED"
      })),
      lastSuccessfulCollectionAt: null,
      latestTaskStatus: null,
      version: 1,
      createdAt: now,
      updatedAt: now
    };
    this.brands.push(brand);
    return structuredClone(brand);
  }

  async updateBrand(brandId: string, version: number, input: OptionalPatch<BrandCreateInput>): Promise<Brand> {
    const brand = this.brands.find((item) => item.id === brandId);
    if (!brand) throw new RepositoryError("NOT_FOUND", 404, false, "品牌不存在。");
    if (brand.version !== version) throw new RepositoryError("VERSION_CONFLICT", 409, false, "品牌数据已经变化，请重新加载。");
    if (input.name && this.brands.some((item) => item.id !== brandId && item.name.toLowerCase() === input.name?.toLowerCase())) {
      throw new RepositoryError("DUPLICATE_RESOURCE", 409, false, "品牌名称已经存在。");
    }
    if (input.name !== undefined) brand.name = input.name;
    if (input.status !== undefined) brand.status = input.status;
    if (input.searchTerms !== undefined) {
      brand.searchTerms = input.searchTerms.map((term) => ({
        id: `mock-term-${randomUUID()}`,
        type: term.type,
        value: term.value,
        status: "ENABLED"
      }));
    }
    brand.version += 1;
    brand.updatedAt = new Date().toISOString();
    return structuredClone(brand);
  }

  async listClassifications(options: ListOptions): Promise<Page<ClassificationItem>> {
    rejectUnsupportedOptions(options, ["classificationType", "isEnabled"]);
    const items = this.classifications.filter((item) => {
      if (options.classificationType && item.classificationType !== options.classificationType) return false;
      if (options.isEnabled !== undefined && item.isEnabled !== options.isEnabled) return false;
      return true;
    });
    return paginate(structuredClone(items), options);
  }

  async listCollectionRuns(options: ListOptions): Promise<CollectionRunPage> {
    rejectUnsupportedOptions(options, ["status", "statuses", "brandIds", "from", "to"]);
    const items = this.tasks.filter((task) => {
      if (options.status && task.status !== options.status) return false;
      if (options.statuses && !options.statuses.includes(task.status)) return false;
      if (options.brandIds && !options.brandIds.includes(task.brandId)) return false;
      if (options.from && (!task.startedAt || task.startedAt < options.from)) return false;
      if (options.to && (!task.startedAt || task.startedAt > options.to)) return false;
      return true;
    });
    const result = paginate(structuredClone(items), options);
    const terminalTasks = this.tasks.filter((task) => !["QUEUED", "RUNNING"].includes(task.status));
    const latestFirst = [...terminalTasks].sort((left, right) =>
      (right.finishedAt ?? right.startedAt ?? "").localeCompare(left.finishedAt ?? left.startedAt ?? "")
    );
    const lastSuccessfulCollectionAt = latestFirst.find((task) =>
      task.status === "SUCCESS" || task.status === "PARTIAL_SUCCESS"
    )?.finishedAt ?? null;
    let consecutiveFailureCount = 0;
    for (const task of latestFirst) {
      if (task.status !== "FAILED") break;
      consecutiveFailureCount += 1;
    }
    return {
      ...result,
      lastSuccessfulCollectionAt,
      consecutiveFailureCount,
      volumeAnomaly: latestFirst.some((task) => task.errorType === "volume_anomaly")
    };
  }

  async startManualCollection(brandId: string): Promise<CollectionTaskSummary> {
    const brand = this.brands.find((item) => item.id === brandId);
    if (!brand) throw new RepositoryError("NOT_FOUND", 404, false, "品牌不存在。");
    if (brand.status !== "ENABLED") {
      throw new RepositoryError("VALIDATION_ERROR", 422, false, "只有已启用的品牌可以开始采集。");
    }
    if (this.tasks.some((task) => task.brandId === brandId && (task.status === "QUEUED" || task.status === "RUNNING"))) {
      throw new RepositoryError("COLLECTION_ALREADY_RUNNING", 409, false, "该品牌已有采集任务正在执行。");
    }
    const task: CollectionTaskSummary = {
      id: `mock-task-${randomUUID()}`,
      brandId,
      triggerType: "MANUAL",
      status: "QUEUED",
      startedAt: null,
      finishedAt: null,
      succeededPostCount: 0,
      failedPostCount: 0,
      errorType: null,
      errorSummary: null,
      retryOfTaskId: null
    };
    this.tasks.unshift(task);
    brand.latestTaskStatus = "QUEUED";
    return structuredClone(task);
  }

  async retryCollectionRun(taskId: string): Promise<CollectionTaskSummary> {
    const original = this.tasks.find((task) => task.id === taskId);
    if (!original) throw new RepositoryError("NOT_FOUND", 404, false, "采集任务不存在。");
    if (original.status !== "FAILED" && original.status !== "PARTIAL_SUCCESS") {
      throw new RepositoryError("VALIDATION_ERROR", 422, false, "只有失败或部分成功的任务可以重试。");
    }
    if (this.tasks.some((task) => task.brandId === original.brandId && (task.status === "QUEUED" || task.status === "RUNNING"))) {
      throw new RepositoryError("COLLECTION_ALREADY_RUNNING", 409, false, "该品牌已有采集任务正在执行。");
    }
    const retry: CollectionTaskSummary = {
      id: `mock-task-${randomUUID()}`,
      brandId: original.brandId,
      triggerType: "RETRY",
      status: "QUEUED",
      startedAt: null,
      finishedAt: null,
      succeededPostCount: 0,
      failedPostCount: 0,
      errorType: null,
      errorSummary: null,
      retryOfTaskId: original.id
    };
    this.tasks.unshift(retry);
    const brand = this.brands.find((item) => item.id === original.brandId);
    if (brand) brand.latestTaskStatus = "QUEUED";
    return structuredClone(retry);
  }

  async updateCorrection(
    contentType: "POST" | "COMMENT",
    contentId: string,
    version: number,
    input: OptionalPatch<EffectiveAnalysis>
  ): Promise<EffectiveAnalysis> {
    const content = this.contents.find((item) => item.contentType === contentType && item.id === contentId);
    if (!content) throw new RepositoryError("NOT_FOUND", 404, false, "内容不存在。");
    if (content.effectiveAnalysis.version !== version) {
      throw new RepositoryError("VERSION_CONFLICT", 409, false, "分析结果已经变化，请重新加载。");
    }
    if (content.modelAnalysis === null) content.modelAnalysis = structuredClone(content.effectiveAnalysis);
    content.effectiveAnalysis = {
      ...content.effectiveAnalysis,
      ...withoutUndefined(input),
      analysisOrigin: "SIMULATED",
      correctedAt: new Date().toISOString(),
      version: version + 1
    };
    return structuredClone(content.effectiveAnalysis);
  }

  async deleteCorrection(contentType: "POST" | "COMMENT", contentId: string, version: number): Promise<EffectiveAnalysis> {
    const content = this.contents.find((item) => item.contentType === contentType && item.id === contentId);
    if (!content) throw new RepositoryError("NOT_FOUND", 404, false, "内容不存在。");
    if (content.effectiveAnalysis.version !== version) {
      throw new RepositoryError("VERSION_CONFLICT", 409, false, "分析结果已经变化，请重新加载。");
    }
    if (content.modelAnalysis === null || content.effectiveAnalysis.correctedAt === null) {
      throw new RepositoryError("VALIDATION_ERROR", 422, false, "当前内容没有可以撤销的人工修正。");
    }
    content.effectiveAnalysis = { ...structuredClone(content.modelAnalysis), correctedAt: null, version: version + 1 };
    return structuredClone(content.effectiveAnalysis);
  }
}
