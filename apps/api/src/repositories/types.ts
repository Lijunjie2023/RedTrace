import type {
  Brand,
  ClassificationItem,
  CollectionRunCreateInput,
  CollectionTaskSummary,
  CollectionStatusSummary,
  ContentDetail,
  ContentSummary,
  DataManagementSummary,
  EffectiveAnalysis,
  ErrorCode,
  Keyword,
  OverviewData,
  CredentialKind,
  ServiceCredentialSummary,
  Topic
} from "@readtrace/contracts";

export interface ListOptions {
  page: number;
  pageSize: 10 | 20 | 50 | 100;
  sortOrder: "ASC" | "DESC";
  keyword?: string;
  contentType?: "POST" | "COMMENT";
  status?: string;
  statuses?: string[];
  from?: string;
  to?: string;
  brandIds?: string[];
  sentiments?: EffectiveAnalysis["sentiment"][];
  categoryIds?: string[];
  problemTypeIds?: string[];
  topicIds?: string[];
  contentNatures?: string[];
  riskLevels?: EffectiveAnalysis["riskLevel"][];
  productSeries?: string;
  productModel?: string;
  classificationType?: ClassificationItem["classificationType"];
  isEnabled?: boolean;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: 10 | 20 | 50 | 100;
  totalItems: number;
}

export interface CollectionRunPage extends Page<CollectionTaskSummary>, CollectionStatusSummary {}

export interface BrandCreateInput {
  name: string;
  status: Brand["status"];
  searchTerms: Array<{ type: Brand["searchTerms"][number]["type"]; value: string }>;
}

export type OptionalPatch<T> = { [Key in keyof T]?: T[Key] | undefined };

export interface DataRepository {
  close(): Promise<void>;
  getOverview(options: ListOptions): Promise<OverviewData>;
  getDataManagementSummary(): Promise<DataManagementSummary>;
  listTopics(options: ListOptions): Promise<Page<Topic>>;
  listKeywords(options: ListOptions): Promise<Page<Keyword>>;
  listTopicEvidence(topicId: string, options: ListOptions): Promise<Page<ContentDetail["context"][number]>>;
  listContents(options: ListOptions): Promise<Page<ContentSummary>>;
  getContent(contentType: "POST" | "COMMENT", contentId: string): Promise<ContentDetail>;
  listBrands(options: ListOptions): Promise<Page<Brand>>;
  createBrand(input: BrandCreateInput): Promise<Brand>;
  updateBrand(brandId: string, version: number, input: OptionalPatch<BrandCreateInput>): Promise<Brand>;
  listClassifications(options: ListOptions): Promise<Page<ClassificationItem>>;
  listCollectionRuns(options: ListOptions): Promise<CollectionRunPage>;
  listServiceCredentials(): Promise<ServiceCredentialSummary[]>;
  saveServiceCredential(kind: CredentialKind, secret: string): Promise<ServiceCredentialSummary>;
  deleteServiceCredential(kind: CredentialKind): Promise<ServiceCredentialSummary>;
  startCollection(input: CollectionRunCreateInput): Promise<CollectionTaskSummary>;
  stopCollection(taskId: string): Promise<CollectionTaskSummary>;
  startManualCollection(brandId: string): Promise<CollectionTaskSummary>;
  retryCollectionRun(taskId: string): Promise<CollectionTaskSummary>;
  updateCorrection(
    contentType: "POST" | "COMMENT",
    contentId: string,
    version: number,
    input: OptionalPatch<EffectiveAnalysis>
  ): Promise<EffectiveAnalysis>;
  deleteCorrection(contentType: "POST" | "COMMENT", contentId: string, version: number): Promise<EffectiveAnalysis>;
}

export class RepositoryError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly statusCode: number,
    readonly retryable: boolean,
    message: string
  ) {
    super(message);
    this.name = "RepositoryError";
  }
}

export function dataNotReady(): never {
  throw new RepositoryError("DATA_NOT_READY", 503, false, "所需数据尚未准备完成。已保留现有采集数据。");
}

export function notImplemented(): never {
  throw new RepositoryError("NOT_IMPLEMENTED", 501, false, "当前开发阶段尚未实现该操作。");
}
