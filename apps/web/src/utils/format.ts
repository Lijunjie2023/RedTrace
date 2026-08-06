const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

const numberFormatter = new Intl.NumberFormat("zh-CN");

export function formatDateTime(value: string | null): string {
  return value ? dateTimeFormatter.format(new Date(value)) : "暂无";
}

export function formatNumber(value: number | null): string {
  return value === null ? "缺失" : numberFormatter.format(value);
}

export function formatPercent(value: number | null): string {
  return value === null ? "缺失" : `${(value * 100).toFixed(1)}％`;
}

export function enumLabel(value: string | null | undefined): string {
  if (!value) return "暂无";
  const labels: Record<string, string> = {
    POST: "帖子", COMMENT: "评论", POSITIVE: "正向", NEUTRAL: "中性", NEGATIVE: "负向", UNKNOWN: "无法判断",
    NORMAL: "普通", WATCH: "关注", HIGH_RISK: "高风险", HIGH: "高", MEDIUM: "中", LOW: "低",
    DRAFT: "草稿", ENABLED: "已启用", DISABLED: "已停用", ARCHIVED: "已归档",
    QUEUED: "等待执行", RUNNING: "执行中", SUCCESS: "成功", PARTIAL_SUCCESS: "部分成功", FAILED: "失败",
    NOT_COLLECTED: "尚未采集", HEALTHY: "正常", PARTIAL: "部分成功", STALE: "数据延迟",
    MODEL: "模型结果", HUMAN_OVERRIDE: "人工修正", SIMULATED: "模拟分析", UNAVAILABLE: "暂无分析",
    MANUAL: "手动", SCHEDULED: "定时", RETRY: "重试", ALIAS: "别名", EXCLUDE: "排除词"
  };
  return labels[value] ?? value;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "请求失败，请稍后重试";
}
