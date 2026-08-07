import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, ContractError, type ContentSummary } from "../api/client";
import { useResponseMeta } from "../api/meta-store";
import { useResource } from "../hooks/use-resource";
import { enumLabel, errorMessage, formatDateTime, formatNumber } from "../utils/format";
import { Icon } from "./icons";

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
  const icon = risk || warning ? "warning" : positive ? "check" : "info";
  return <span className={`status-badge ${risk ? "is-risk" : warning ? "is-warning" : positive ? "is-positive" : ""}`}><Icon name={icon} />{enumLabel(value)}</span>;
}

export function ErrorNotice({ error, retry, compact = false }: { error: unknown; retry?: () => void; compact?: boolean }): ReactNode {
  const requestId = error instanceof ApiError || error instanceof ContractError ? error.requestId : null;
  const code = error instanceof ApiError ? error.code : error instanceof ContractError ? "CONTRACT_ERROR" : "NETWORK_ERROR";
  const copy = code === "DATA_NOT_READY"
    ? ["统计分析正在准备", "原始采集数据仍然保留，可以先查看内容库或采集状态。"]
    : code === "DEPENDENCY_UNAVAILABLE"
      ? ["数据服务暂时不可用", "服务正在恢复，可以稍后重试或查看采集状态。"]
      : code === "CONTRACT_ERROR"
        ? ["数据格式异常", "接口返回内容与当前版本不一致，请联系维护人员。"]
        : code === "NOT_FOUND"
          ? ["请求内容不存在", "这条内容可能已被删除，或者当前链接已经失效。"]
          : code === "VALIDATION_ERROR"
            ? ["筛选条件有误", "请检查日期范围和筛选条件后重新加载。"]
        : ["无法连接数据服务", "请检查网络连接，或稍后重新加载。"];
  return (
    <div className={`notice notice--error ${compact ? "notice--compact" : ""}`} role="alert">
      <span className="notice__icon"><Icon name="warning" /></span>
      <div className="notice__body"><strong>{copy[0]}</strong><p>{copy[1]}</p>{requestId ? <details><summary>技术信息</summary><small>请求编号：{requestId} · {errorMessage(error)}</small></details> : null}</div>
      <div className="notice__actions">{code === "DATA_NOT_READY" ? <><Link className="button button--quiet" to="/content">查看内容库</Link><Link className="button button--quiet" to="/data-status">查看数据状态</Link></> : code === "DEPENDENCY_UNAVAILABLE" ? <Link className="button button--quiet" to="/data-status">查看数据状态</Link> : null}{retry ? <button className="button button--primary" type="button" onClick={retry}>重新加载</button> : null}</div>
    </div>
  );
}

export function LoadingState({ label = "正在读取数据" }: { label?: string }): ReactNode {
  return <div className="loading-state" role="status"><span className="loading-mark" aria-hidden="true" />{label}</div>;
}

export function EmptyState({ kind, onClear }: { kind: "not-collected" | "filtered" | "analysis"; onClear?: () => void }): ReactNode {
  const copy = {
    "not-collected": ["尚未完成首次采集", "完成监控设置并成功采集后，这里会显示真实舆情数据。"],
    filtered: ["当前筛选没有结果", "已保留筛选条件，可以调整条件或清除筛选。"],
    analysis: ["暂无可验证的分析", "原始内容仍可查看，原因主题需要等待有效分析和原始证据。"]
  }[kind];
  return (
    <div className="empty-state">
      <Icon name="database" /><h3>{copy[0]}</h3><p>{copy[1]}</p>
      {kind === "not-collected" ? <Link className="text-link" to="/brands">前往监控设置</Link> : null}
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

function MultiSelectFilter({ id, label, options, selected, placeholder, disabled, open, onOpenChange, onChange }: {
  id: string;
  label: string;
  options: Array<{ id: string; name: string }>;
  selected: string[];
  placeholder: string;
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (ids: string[]) => void;
}): ReactNode {
  const [query, setQuery] = useState("");
  const componentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const closeOutside = (event: PointerEvent) => {
      if (!componentRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, onOpenChange]);
  const visible = options.filter((option) => option.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selectedNames = selected.map((id) => options.find((option) => option.id === id)?.name ?? "已选项");
  const summary = selected.length === 0 ? placeholder : selected.length === 1 ? selectedNames[0] : `已选${selected.length}项`;
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id]);
  return (
    <div ref={componentRef} className="multi-select-filter">
      <span className="multi-select-filter__label">{label}</span>
      <button className="multi-select-filter__trigger" type="button" aria-label={`${label}：${summary}`} aria-expanded={open} aria-controls={`${id}-options`} disabled={disabled} onClick={() => onOpenChange(!open)}>{disabled ? "正在读取" : summary}<span aria-hidden="true">⌄</span></button>
        {open && !disabled ? <div className="multi-select-filter__popover" id={`${id}-options`}>
          <label className="multi-select-filter__search"><span className="visually-hidden">搜索{label}</span><input type="search" value={query} placeholder={`搜索${label}`} onChange={(event) => setQuery(event.target.value)} /></label>
          <div className="multi-select-filter__actions"><button type="button" onClick={() => onChange(options.map((option) => option.id))}>全选</button><button type="button" onClick={() => onChange([])}>清空</button></div>
          <div className="multi-select-filter__options">
            {visible.length ? visible.map((option) => <label key={option.id}><input type="checkbox" checked={selected.includes(option.id)} onChange={() => toggle(option.id)} /><span>{option.name}</span></label>) : <p>没有匹配项</p>}
          </div>
        </div> : null}
    </div>
  );
}

export function FilterBar({ search, setSearch, draftSearch, setDraftSearch, showSentiment = true, showCategory = false, showDate = true, deferred = false, defaultSearch, sticky = false }: {
  search: URLSearchParams;
  setSearch: (next: URLSearchParams) => void;
  draftSearch?: URLSearchParams;
  setDraftSearch?: (next: URLSearchParams) => void;
  showSentiment?: boolean;
  showCategory?: boolean;
  showDate?: boolean;
  deferred?: boolean;
  defaultSearch?: URLSearchParams;
  sticky?: boolean;
}): ReactNode {
  const searchKey = search.toString();
  const [internalDraft, setInternalDraft] = useState(() => new URLSearchParams(searchKey));
  const [openFilter, setOpenFilter] = useState<"brand" | "category" | null>(null);
  const brandLoader = useMemo(() => () => api.getBrands(), []);
  const brands = useResource(brandLoader, []);
  const classificationLoader = useMemo(() => () => api.getClassifications(), []);
  const classifications = useResource(classificationLoader, []);
  useEffect(() => {
    if (!draftSearch) setInternalDraft(new URLSearchParams(searchKey));
  }, [draftSearch, searchKey]);
  const current = deferred ? draftSearch ?? internalDraft : search;
  const updateDraft = (next: URLSearchParams) => {
    if (setDraftSearch) setDraftSearch(next); else setInternalDraft(next);
  };
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(current);
    if (value) next.set(key, value); else next.delete(key);
    if (key === "brandIds" || key === "categoryIds") next.delete("topicId");
    next.delete("page");
    if (deferred) updateDraft(next); else setSearch(next);
  };
  const clear = () => {
    const next = new URLSearchParams(defaultSearch ?? "");
    if (deferred) updateDraft(next); else setSearch(next);
    setOpenFilter(null);
  };
  const apply = () => {
    const next = new URLSearchParams(current);
    next.delete("topicId");
    next.delete("page");
    setOpenFilter(null);
    setSearch(next);
  };
  const selectedBrandIds = (current.get("brandIds") ?? "").split(",").filter(Boolean);
  const selectedCategoryIds = (current.get("categoryIds") ?? "").split(",").filter(Boolean);
  const categoryOptions = classifications.data?.items
    .filter((item) => item.classificationType === "CATEGORY" && item.isEnabled)
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((item) => ({ id: item.id, name: item.displayName })) ?? [];
  return (
    <div className={`filter-bar ${sticky ? "is-sticky" : ""}`} aria-label="数据筛选">
      {showDate ? <><label><span>开始时间</span><input type="date" value={current.get("from")?.slice(0, 10) ?? ""} onChange={(event) => update("from", event.target.value ? `${event.target.value}T00:00:00+08:00` : "")} /></label><label><span>结束时间</span><input type="date" value={current.get("to")?.slice(0, 10) ?? ""} onChange={(event) => update("to", event.target.value ? `${event.target.value}T23:59:59+08:00` : "")} /></label></> : null}
      <MultiSelectFilter id="brand-filter" label="监控品牌" options={brands.data?.items.map((brand) => ({ id: brand.id, name: brand.name })) ?? []} selected={selectedBrandIds} placeholder={brands.error ? "品牌暂不可用" : "全部品牌"} disabled={brands.loading || Boolean(brands.error)} open={openFilter === "brand"} onOpenChange={(open) => setOpenFilter(open ? "brand" : null)} onChange={(ids) => update("brandIds", ids.join(","))} />
      {showCategory ? <MultiSelectFilter id="category-filter" label="产品品类" options={categoryOptions} selected={selectedCategoryIds} placeholder={classifications.error ? "品类暂不可用" : "全部品类"} disabled={classifications.loading || Boolean(classifications.error)} open={openFilter === "category"} onOpenChange={(open) => setOpenFilter(open ? "category" : null)} onChange={(ids) => update("categoryIds", ids.join(","))} /> : null}
      {showSentiment ? <label><span>情感倾向</span><select value={current.get("sentiments") ?? current.get("sentiment") ?? ""} onChange={(event) => update("sentiments", event.target.value)}><option value="">全部</option><option value="NEGATIVE">负向</option><option value="NEUTRAL">中性</option><option value="POSITIVE">正向</option></select></label> : null}
      {current.size > 0 || deferred ? <div className="filter-bar__actions"><button className="button button--quiet" type="button" onClick={clear}>清除筛选</button>{deferred ? <button className="button button--primary" type="button" onClick={apply}>查询</button> : null}</div> : null}
    </div>
  );
}
