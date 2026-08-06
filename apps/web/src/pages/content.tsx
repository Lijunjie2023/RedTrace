import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type ContentSummary } from "../api/client";
import { DataModeStamp, ErrorNotice, ExportButton, FilterBar, OriginalLink, StatusBadge } from "../components/common";
import { PageHeader, SkeletonPage } from "../components/page";
import { useResource } from "../hooks/use-resource";
import { enumLabel, formatDateTime, formatNumber } from "../utils/format";

export function ContentPage(): ReactNode {
  const [search, setSearch] = useSearchParams();
  const contentType = search.get("contentType") === "COMMENT" ? "COMMENT" : "POST";
  const contentLabel = contentType === "COMMENT" ? "评论" : "帖子";
  const requestSearch = useMemo(() => {
    const value = new URLSearchParams(search);
    value.set("contentType", contentType);
    if (!value.has("page")) value.set("page", "1");
    if (!value.has("pageSize")) value.set("pageSize", "20");
    return value;
  }, [contentType, search]);
  const key = requestSearch.toString();
  const resource = useResource(useMemo(() => () => api.getContents(new URLSearchParams(key)), [key]), [key]);
  const [selected, setSelected] = useState<ContentSummary | null>(null);

  useEffect(() => {
    if (search.get("contentType") === contentType) return;
    const next = new URLSearchParams(search);
    next.set("contentType", contentType);
    setSearch(next, { replace: true });
  }, [contentType, search, setSearch]);

  useEffect(() => {
    if (resource.data?.items.length && !resource.data.items.some((item) => item.id === selected?.id)) setSelected(resource.data.items[0]);
    if (resource.data?.items.length === 0) setSelected(null);
  }, [resource.data, selected?.id]);

  const setType = (value: "POST" | "COMMENT") => {
    const next = new URLSearchParams(search);
    next.set("contentType", value);
    next.set("page", "1");
    setSearch(next);
  };
  const setPage = (page: number) => {
    const next = new URLSearchParams(search);
    next.set("page", String(page));
    setSearch(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  if (resource.loading) return <><PageHeader eyebrow="证据库" title={`${contentLabel}库`} description={`筛选${contentLabel}，核对原文、上下文和有效分析。`} /><SkeletonPage /></>;
  if (!resource.data) return <><PageHeader eyebrow="证据库" title={`${contentLabel}库`} description={`筛选${contentLabel}，核对原文、上下文和有效分析。`} /><ErrorNotice error={resource.error} retry={resource.retry} /></>;

  return (
    <>
      <PageHeader eyebrow="证据库" title={`${contentLabel}库`} description={`${contentLabel}筛选条件写入链接，刷新和返回后仍然保留。`} action={<ExportButton filters={requestSearch} />} />
      <FilterBar search={search} setSearch={setSearch} />
      <div className="content-toolbar"><div className="segmented" aria-label="内容类型"><button className={contentType === "POST" ? "is-active" : ""} type="button" onClick={() => setType("POST")}>帖子</button><button className={contentType === "COMMENT" ? "is-active" : ""} type="button" onClick={() => setType("COMMENT")}>评论</button></div><span>共{resource.data.pagination.totalItems}条{contentLabel}</span></div>
      {resource.error ? <ErrorNotice error={resource.error} retry={resource.retry} compact /> : null}
      {resource.data.items.length === 0 ? <div className="empty-state"><span aria-hidden="true">⌁</span><h3>当前筛选没有{contentLabel}</h3><p>已保留内容类型，可以调整其他条件或清除筛选。</p><button className="button button--quiet" type="button" onClick={() => setSearch(new URLSearchParams({ contentType, page: "1" }))}>清除其他筛选</button></div> : (
        <div className={`content-layout ${resource.refreshing ? "is-refreshing" : ""}`}>
          <section className="content-list" aria-label="内容列表"><DataModeStamp />{resource.data.items.map((item) => <article className={`content-row ${selected?.id === item.id ? "is-active" : ""}`} key={`${item.contentType}-${item.id}`}><button className="content-row__select" type="button" onClick={() => setSelected(item)} aria-label={`预览${item.title ?? "当前内容"}`}><div className="content-row__meta"><span>{enumLabel(item.contentType)}</span><StatusBadge value={item.effectiveAnalysis.riskLevel} /><span>{formatDateTime(item.publishedAt)}</span></div><h2>{item.title ?? (item.contentType === "COMMENT" ? "评论原文" : "无标题帖子")}</h2><p>{item.excerpt ?? "原文内容缺失"}</p><div><span>点赞{formatNumber(item.likedCount)}</span><span>{enumLabel(item.effectiveAnalysis.analysisOrigin)}</span><span>{enumLabel(item.effectiveAnalysis.confidence)}可信度</span></div></button><Link className="content-row__detail" to={`/content/${item.contentType}/${item.id}`}>查看详情与修正</Link></article>)}</section>
          <aside className="content-preview">{selected ? <><header><span>当前证据</span><h2>{selected.title ?? "原文预览"}</h2></header><p className="content-preview__text">{selected.excerpt ?? "原文内容缺失"}</p><dl><div><dt>情感</dt><dd><StatusBadge value={selected.effectiveAnalysis.sentiment} /></dd></div><div><dt>风险</dt><dd><StatusBadge value={selected.effectiveAnalysis.riskLevel} /></dd></div><div><dt>分析来源</dt><dd>{enumLabel(selected.effectiveAnalysis.analysisOrigin)}</dd></div><div><dt>最后采集</dt><dd>{formatDateTime(selected.lastCollectedAt)}</dd></div></dl><div className="preview-actions"><Link className="button button--primary" to={`/content/${selected.contentType}/${selected.id}`}>查看详情与修正</Link><OriginalLink sourceUrl={selected.sourceUrl} canOpen={selected.canOpenOriginal} /></div></> : null}</aside>
        </div>
      )}
      {resource.data.pagination.totalPages > 0 ? <nav className="pagination" aria-label="内容分页"><button className="button button--quiet" type="button" disabled={resource.data.pagination.page <= 1} onClick={() => setPage(resource.data!.pagination.page - 1)}>上一页</button><span>第{resource.data.pagination.page}页，共{resource.data.pagination.totalPages}页 · {resource.data.pagination.totalItems}条</span><button className="button button--quiet" type="button" disabled={resource.data.pagination.page >= resource.data.pagination.totalPages} onClick={() => setPage(resource.data!.pagination.page + 1)}>下一页</button></nav> : null}
    </>
  );
}
