import type { ReactNode } from "react";

export type IconName = "overview" | "insights" | "content" | "keywords" | "settings" | "brands" | "status" | "logout" | "database" | "warning" | "check" | "info" | "arrow";

const paths: Record<IconName, ReactNode> = {
  overview: <><path d="M4 13h6V4H4zM14 20h6V9h-6zM4 20h6v-3H4zM14 5h6" /></>,
  insights: <><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4M8 12l2-2 2 2 3-4" /></>,
  content: <><path d="M6 3h10l3 3v15H6zM16 3v4h4M9 11h7M9 15h7" /></>,
  keywords: <><path d="M7 4 5 20M15 4l-2 16M3 9h16M2 15h16" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 9 19.37a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.63 15 1.7 1.7 0 0 0 3.08 14H3v-4h.08A1.7 1.7 0 0 0 4.63 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.63 1.7 1.7 0 0 0 10 3.08V3h4v.08A1.7 1.7 0 0 0 15 4.63a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.37 9 1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" /></>,
  brands: <><path d="M5 9h14M9 5v4M15 5v4M7 9v10M17 9v10M4 19h16" /><circle cx="12" cy="13" r="2" /></>,
  status: <><path d="M4 15h3l2-7 4 11 2-6h5" /><path d="M4 4h16v16H4z" /></>,
  logout: <><path d="M10 5H5v14h5M14 8l4 4-4 4M18 12H9" /></>,
  database: <><ellipse cx="12" cy="5" rx="7" ry="3" /><path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7" /></>,
  warning: <><path d="M12 3 2.8 20h18.4z" /><path d="M12 9v5M12 17h.01" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
  arrow: <path d="M5 12h14M14 7l5 5-5 5" />
};

export function Icon({ name, label }: { name: IconName; label?: string }): ReactNode {
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>{paths[name]}</svg>;
}
