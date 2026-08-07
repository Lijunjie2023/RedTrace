function formatDate(value: Date): string {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

export function recentShanghaiRange(now = new Date(), days = 7): URLSearchParams {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  const endDate = new Date(Date.UTC(value("year"), value("month") - 1, value("day")));
  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - (days - 1));
  return new URLSearchParams({
    from: `${formatDate(startDate)}T00:00:00+08:00`,
    to: `${formatDate(endDate)}T23:59:59+08:00`
  });
}
