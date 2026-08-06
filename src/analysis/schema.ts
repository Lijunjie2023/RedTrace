import { z } from "zod";
import type { AnalysisResult, ClassificationItem, TokenUsage } from "./types.js";

const TaxonomyIdSchema = z.union([
  z.string().regex(/^\d+$/),
  z.number().int().nonnegative().refine((value) => Number.isSafeInteger(value))
]).transform((value) => String(value));

const ConfidenceSchema = z.union([
  z.enum(["HIGH", "MEDIUM", "LOW"]),
  z.number().finite().min(0).max(1).transform((value) => {
    if (value >= 0.8) return "HIGH" as const;
    if (value >= 0.5) return "MEDIUM" as const;
    return "LOW" as const;
  })
]);

const RiskLevelSchema = z.enum(["NORMAL", "WATCH", "HIGH_RISK", "HIGH", "MEDIUM", "LOW"])
  .transform((value) => {
    if (value === "HIGH") return "HIGH_RISK" as const;
    if (value === "MEDIUM") return "WATCH" as const;
    if (value === "LOW") return "NORMAL" as const;
    return value;
  });

export const AnalysisResultSchema = z.object({
  sentiment: z.enum(["POSITIVE", "NEUTRAL", "NEGATIVE", "UNKNOWN"]),
  contentNature: z.string().trim().min(1).max(191).nullable(),
  problemTypeIds: z.array(TaxonomyIdSchema).max(20),
  categoryId: TaxonomyIdSchema.nullable(),
  productSeries: z.string().trim().min(1).max(191).nullable(),
  productModel: z.string().trim().min(1).max(191).nullable(),
  userStage: z.string().trim().min(1).max(191).nullable(),
  riskLevel: RiskLevelSchema,
  confidence: ConfidenceSchema,
  topicIds: z.array(TaxonomyIdSchema).max(20)
}).strict();

export class AnalysisValidationError extends Error {
  constructor(
    readonly errorCode: "invalid_json" | "schema_invalid" | "taxonomy_id_invalid",
    readonly usage?: TokenUsage
  ) {
    super(errorCode);
    this.name = "AnalysisValidationError";
  }
}

export function parseAnalysisResult(value: unknown, taxonomy: ClassificationItem[]): AnalysisResult {
  const parsed = AnalysisResultSchema.safeParse(value);
  if (!parsed.success) throw new AnalysisValidationError("schema_invalid");
  const enabledByType = new Map<string, Set<string>>();
  for (const item of taxonomy) {
    const values = enabledByType.get(item.classificationType) ?? new Set<string>();
    values.add(item.id);
    enabledByType.set(item.classificationType, values);
  }
  const categoryIds = enabledByType.get("CATEGORY") ?? new Set<string>();
  const problemTypeIds = enabledByType.get("PROBLEM_TYPE") ?? new Set<string>();
  const topicIds = enabledByType.get("TOPIC") ?? new Set<string>();
  if ((parsed.data.categoryId !== null && !categoryIds.has(parsed.data.categoryId))
    || parsed.data.problemTypeIds.some((id) => !problemTypeIds.has(id))
    || parsed.data.topicIds.some((id) => !topicIds.has(id))) {
    throw new AnalysisValidationError("taxonomy_id_invalid");
  }
  return {
    ...parsed.data,
    problemTypeIds: [...new Set(parsed.data.problemTypeIds)],
    topicIds: [...new Set(parsed.data.topicIds)]
  };
}
