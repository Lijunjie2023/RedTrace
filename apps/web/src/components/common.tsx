import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ApiError, ContractError, type ContentSummary } from "../api/client";
import { useResponseMeta } from "../api/meta-store";
import { enumLabel, errorMessage, formatDateTime, formatNumber } from "../utils/format";

export function DataModeStamp(): ReactNode {
  const meta = useResponseMeta();
  return meta?.dataMode === "MOCK" ? <span className="data-stamp">模拟数据</span> : null;
}

export function Panel({ title, caption, action, className = "", children }: {
  title: string;
  caption?: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <section className={`panel ${className}`}>
      <DataModeStamp />
      <header className="panel__header">
        <div><h2>{title}</h2>{caption ? <p>{caption}</p> : null}</div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function StatusBadge({ value }: { value: string | null | undefined }): ReactNode {
  const risk = ["FAILED", "HIGH_RISK", "NEGATIVE"].includes(value ?? "");
  const warning = ["WATCH", "PARTIAL", "PARTIAL_SUCCESS", "STALE", "LOW"].includes(value ?? "");
  const positive = ["SUCCESS", "HEALTHY", "POSITIVE", "ENABLED", "HIGH"].includes(value ?? "");
  const icon = risk ? "!" : warning ? "△" : positive ? "✓" : "•";
  return <span className={`status-badge ${risk ? "is-risk" : warning ? "is-warning" : positive ? "is-positive" : ""}`}><b aria-hidden="true">{icon}</b>{enumLabel(value)}</span>;
}

export function ErrorNotice({ error, retry, compact = false }: { error: unknown; retry?: () => void; compact?: boolean }): ReactNode {
  const requestId = error instanceof ApiError || error instanceof ContractError ? error.requestId : null;
  return (
    <div className={`notice notice--error ${compact ? "notice--compact" : ""}`} role="alert">
      <span className="notice__icon" aria-hidden="true">!</span>
      <div><strong>{error instanceof ContractError ? "数据格式异常" : "数据请求失败"}</strong><p>{errorMessage(error)}</p>{requestId ? <small>请求编号：{requestId}</small> : null}</div>
      {retry ? <button className="button button--quiet" type="button" onClick={retry}>重新加载</button> : null}
    </div>
  );
}

export function LoadingState({ label = "正在读取数据" }: { label?: string }): ReactNode {
  return <div className="loading-state" role="status"><span className="loading-mark" aria-hidden="true" />{label}</div>;
}

export function EmptyState({ kind, onClear }: { kind: "not-collected" | "filtered" | "analysis"; onClear?: () => void }): ReactNode {
  const copy = {
    "not-collected": ["尚未采集", "品牌启用后会进入每小时采集流程，首次成功前不会显示为零舆情。"],
    filtered: ["当前筛选没有结果", "已保留筛选条件，可以调整条件或清除筛选。"],
    analysis: ["暂无可验证的分析", "原始内容仍可查看，原因主题需要等待有效分析和原始证据。"]
  }[kind];
  return (
    <div className="empty-state">
      <span aria-hidden="true">⌁</span><h3>{copy[0]}</h3><p>{copy[1]}</p>
      {kind === "not-collected" ? <Link className="text-link" to="/brands">前往品牌监控</Link> : null}
      {onClear ? <button className="button button--quiet" type="button" onClick={onClear}>清除筛选</button> : null}
    </div>
  );
}

export function DataHealth({ health, lastSuccessfulAt }: { health: string; lastSuccessfulAt: string | null }): ReactNode {
  const delayed = ["FAILED", "STALE", "PARTIAL"].includes(health);
  return (
    <div className={`health-strip ${delayed ? "is-warning" : ""}`}>
      <StatusBadge value={health} />
      <span>{lastSuccessfulAt ? `统计数据截至${formatDateTime(lastSuccessfulAt)}` : "还没有成功采集记录"}</span>
      {delayed ? <Link to="/data-status">查看数据状态</Link> : null}
    </div>
  );
}

export function EvidenceItem({ item, active = false }: { item: ContentSummary; active?: boolean }): ReactNode {
  const simulated = item.evidenceOrigin === "SIMULATED";
  return (
    <article className={`evidence-item ${active ? "is-active" : ""}`}>
      <div className="evidence-item__meta"><StatusBadge value={item.effectiveAnalysis.riskLevel} /><span>{enumLabel(item.contentType)}</span><span>{formatDateTime(item.publishedAt)}</span></div>
      <h3>{item.title ?? (item.contentType === "COMMENT" ? "评论原文" : "无标题帖子")}</h3>
      <p className="clamp-3">{item.excerpt ?? "原文内容缺失"}</p>
      <div className="evidence-item__footer"><span>点赞{formatNumber(item.likedCount)}</span><span>{simulated ? "模拟证据" : "原始证据"}</span><Link to={`/content/${item.contentType}/${item.id}`}>查看证据</Link></div>
    </article>
  );
}

export function OriginalLink({ sourceUrl, canOpen, label = "打开原帖" }: { sourceUrl: string | null; canOpen: boolean; label?: string }): ReactNode {
  if (!canOpen || !sourceUrl) return <button className="text-link is-disabled" type="button" disabled title="模拟证据没有原始链接">模拟数据不可打开原帖</button>;
  return <a className="text-link" href={sourceUrl} target="_blank" rel="noopener noreferrer">{label}<span aria-hidden="true">↗</span></a>;
}

export function ExportButton({ filters }: { filters: URLSearchParams }): ReactNode {
  const meta = useResponseMeta();
  void filters;
  const label = meta?.dataMode === "MOCK" ? "导出模拟数据未开放" : "导出功能未开放";
  return <div className="export-unavailable"><button className="button button--primary" type="button" disabled aria-describedby="export-unavailable-note">{label}</button><small id="export-unavailable-note">当前版本不会生成空文件或不完整文件。</small></div>;
}

export function FilterBar({ search, setSearch, showSentiment = true }: {
  search: URLSearchParams;
  setSearch: (next: URLSearchParams) => void;
  showSentiment?: boolean;
}): ReactNode {
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(search);
    if (value) next.set(key, value); else next.delete(key);
    next.delete("page");
    setSearch(next);
  };
  const clear = () => setSearch(new URLSearchParams());
  return (
    <div className="filter-bar" aria-label="数据筛选">
      <label><span>开始时间</span><input type="date" value={search.get("from")?.slice(0, 10) ?? ""} onChange={(event) => update("from", event.target.value ? `${event.target.value}T00:00:00+08:00` : "")} /></label>
      <label><span>结束时间</span><input type="date" value={search.get("to")?.slice(0, 10) ?? ""} onChange={(event) => update("to", event.target.value ? `${event.target.value}T23:59:59+08:00` : "")} /></label>
      <label><span>品牌编号</span><input value={search.get("brandIds") ?? ""} onChange={(event) => update("brandIds", event.target.value)} placeholder="多个编号用逗号分隔" /></label>
      {showSentiment ? <label><span>情感倾向</span><select value={search.get("sentiments") ?? search.get("sentiment") ?? ""} onChange={(event) => update("sentiments", event.target.value)}><option value="">全部</option><option value="NEGATIVE">负向</option><option value="NEUTRAL">中性</option><option value="POSITIVE">正向</option></select></label> : null}
      {search.size > 0 ? <button className="button button--quiet" type="button" onClick={clear}>清除筛选</button> : null}
    </div>
  );
}
