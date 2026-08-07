import type { OverviewData } from "@readtrace/contracts";
import type { ListOptions } from "./types.js";
import { RepositoryError } from "./types.js";

const MAX_OVERVIEW_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;
const shanghaiDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

type TrendPoint = OverviewData["sentimentTrend"][number];

export function isWithinDateRange(value: string | null, options: Pick<ListOptions, "from" | "to">): boolean {
  if (options.from === undefined && options.to === undefined) return true;
  if (value === null) return false;
  const timestamp = Date.parse(value);
  if (options.from !== undefined && timestamp < Date.parse(options.from)) return false;
  if (options.to !== undefined && timestamp > Date.parse(options.to)) return false;
  return true;
}

export function shanghaiDate(value: string): string {
  const parts = shanghaiDateFormatter.formatToParts(new Date(value));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new RepositoryError("VALIDATION_ERROR", 400, false, "日期范围不符合要求。");
  }
  return `${year}-${month}-${day}`;
}

function dateOrdinal(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year!, month! - 1, day!);
}

export function overviewDateBuckets(options: ListOptions): string[] | null {
  if ((options.from === undefined) !== (options.to === undefined)) {
    throw new RepositoryError("VALIDATION_ERROR", 400, false, "from和to必须同时提供。");
  }
  if (options.from === undefined || options.to === undefined) return null;
  const start = shanghaiDate(options.from);
  const end = shanghaiDate(options.to);
  const startOrdinal = dateOrdinal(start);
  const endOrdinal = dateOrdinal(end);
  const dayCount = Math.floor((endOrdinal - startOrdinal) / DAY_MS) + 1;
  if (dayCount < 1) {
    throw new RepositoryError("VALIDATION_ERROR", 400, false, "from不能晚于to。");
  }
  if (dayCount > MAX_OVERVIEW_DAYS) {
    throw new RepositoryError("VALIDATION_ERROR", 400, false, "概览日期范围最多支持366天。");
  }
  return Array.from({ length: dayCount }, (_, index) =>
    new Date(startOrdinal + index * DAY_MS).toISOString().slice(0, 10)
  );
}

export function completeSentimentTrend(points: TrendPoint[], buckets: string[] | null): TrendPoint[] {
  if (buckets === null) return points;
  const byBucket = new Map(points.map((point) => [point.bucket, point]));
  return buckets.map((bucket) => byBucket.get(bucket) ?? {
    bucket,
    positive: 0,
    neutral: 0,
    negative: 0,
    unknown: 0
  });
}
