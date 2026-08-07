export type AnalysisContentType = "POST" | "COMMENT";
export type ClassificationType = "CATEGORY" | "PROBLEM_TYPE" | "TOPIC";

export interface ClassificationItem {
  id: string;
  classificationType: ClassificationType;
  code: string;
  displayName: string;
  description: string | null;
  version: number;
}

export interface AnalysisCandidate {
  contentType: AnalysisContentType;
  contentId: string;
  postId: string;
  title: string | null;
  text: string | null;
  tags: string[];
  brandNames: string[];
  postTitle: string | null;
  postContext: string | null;
  parentCommentText: string | null;
}

export interface AnalysisResult {
  sentiment: "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "UNKNOWN";
  contentNature: string | null;
  problemTypeIds: string[];
  categoryId: string | null;
  productSeries: string | null;
  productModel: string | null;
  userStage: string | null;
  riskLevel: "NORMAL" | "WATCH" | "HIGH_RISK";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  topicIds: string[];
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AnalysisRequest {
  idempotencyKey: string;
  inputDigest: string;
  taxonomyDigest: string;
  promptVersion: string;
  modelName: string;
  candidate: AnalysisCandidate;
}

export interface AnalysisStore {
  listEnabledClassifications(): Promise<ClassificationItem[]>;
  listCandidates(contentType: AnalysisContentType, limit: number, beforeId?: string): Promise<AnalysisCandidate[]>;
  hasSuccessfulResult(idempotencyKey: string): Promise<boolean>;
  startAttempt(request: AnalysisRequest, ownerToken: string, leaseMs: number): Promise<boolean>;
  saveSuccess(request: AnalysisRequest, ownerToken: string, result: AnalysisResult, usage: TokenUsage): Promise<void>;
  saveFailure(request: AnalysisRequest, ownerToken: string, errorCode: string, errorSummary: string, usage?: TokenUsage): Promise<void>;
}

export interface AnalysisClient {
  analyze(messages: Array<{ role: "system" | "user"; content: string }>): Promise<{
    result: unknown;
    usage: TokenUsage;
  }>;
}

export interface BatchSummary extends TokenUsage {
  processed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  errorCodes: Record<string, number>;
  stoppedReason?: "TOKEN_BUDGET_EXHAUSTED" | "NON_RECOVERABLE_ERROR";
}
