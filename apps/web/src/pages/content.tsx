import { useEffect, useMemo, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type ContentSummary } from "../api/client";
import { DataModeStamp, ErrorNotice, ExportButton, FilterBar, OriginalLink, StatusBadge } from "../components/common";
import { PageHeader, SkeletonPage } from "../components/page";
import { useResource } from "../hooks/use-resource";
import { enumLabel, formatDateTime, formatNumber } from "../utils/format";

export function ContentPage(): ReactNode {
  const [search, setSearch] = useSearchParams();
  const contentType: "POST" | "COMMENT" = search.get("contentType") === "COMMENT" ? "COMMENT" : "POST";
  const contentLabel = contentType === "COMMENT" ? "评论" : "帖子";
  const requestSearch = useMemo(() => {
    const value = new URLSearchParams(search);
    value.set("contentType", contentType);
    if (contentType === "COMMENT") {
      value.delete("from");
      value.delete("to");
    }
    if (!value.has("page")) value.set("page", "1");
    value.set("pageSize", "10");
    return value;
  }, [contentType, search]);
  const key = requestSearch.toString();
  const resource = useResource(useMemo(() => () => api.getContents(new URLSearchParams(key)), [key]), [key]);
  useEffect(() => {
    const commentHasDate = contentType === "COMMENT" && (search.has("from") || search.has("to"));
    if (search.get("contentType") === contentType && search.get("pageSize") === "10" && !commentHasDate) return;
    const next = new URLSearchParams(search);
    next.set("contentType", contentType);
    next.set("pageSize", "10");
    if (contentType === "COMMENT") {
      next.delete("from");
      next.delete("to");
    }
    setSearch(next, { replace: true });
  }, [contentType, search, setSearch]);

  const setType = (value: "POST" | "COMMENT") => {
    const next = new URLSearchParams(search);
    next.set("contentType", value);
    next.set("pageSize", "10");
    if (value === "COMMENT") {
      next.delete("from");
      next.delete("to");
    }
    next.set("page", "1");
    setSearch(next);
  };
  const setPage = (page: number) => {
    const next = new URLSearchParams(search);
    next.set("page", String(page));
    setSearch(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const visiblePages = (current: number, total: number): Array<number | "ellipsis"> => {
    if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
    const pages = new Set([1, total, current - 1, current, current + 1]);
    const sorted = [...pages].filter((page) => page >= 1 && page <= total).sort((left, right) => left - right);
    const result: Array<number | "ellipsis"> = [];
    sorted.forEach((page, index) => {
      if (index > 0 && page - sorted[index - 1] > 1) result.push("ellipsis");
      result.push(page);
    });
    return result;
  };

  if (resource.loading) return <><PageHeader eyebrow="证据库" title={`${contentLabel}库`} description={`筛选${contentLabel}，核对原文、上下文和有效分析。`} /><SkeletonPage /></>;
  if (!resource.data) return <><PageHeader eyebrow="证据库" title={`${contentLabel}库`} description={`筛选${contentLabel}，核对原文、上下文和有效分析。`} /><ErrorNotice error={resource.error} retry={resource.retry} /></>;
  const pagination = resource.data.pagination;

  return (
    <>
      <PageHeader eyebrow="证据库" title="内容明细" description="查看已采集的帖子与评论，核对原始内容与分析结果。" action={<ExportButton filters={requestSearch} />} />
      <div className="content-toolbar"><div><div className="segmented content-tabs" aria-label="内容类型"><button className={contentType === "POST" ? "is-active" : ""} type="button" onClick={() => setType("POST")}>帖子库</button><button className={contentType === "COMMENT" ? "is-active" : ""} type="button" onClick={() => setType("COMMENT")}>评论库</button></div>{contentType === "COMMENT" ? <small>评论没有可验证的发布时间，日期筛选不适用。</small> : null}</div><span>共{resource.data.pagination.totalItems}条{contentLabel}</span></div>
      <FilterBar search={search} setSearch={setSearch} showDate={contentType !== "COMMENT"} />
      {resource.error ? <ErrorNotice error={resource.error} retry={resource.retry} compact /> : null}
      {resource.data.items.length === 0 ? <div className="empty-state"><span aria-hidden="true">⌁</span><h3>当前筛选没有{contentLabel}</h3><p>已保留内容类型，可以调整其他条件或清除筛选。</p><button className="button button--quiet" type="button" onClick={() => setSearch(new URLSearchParams({ contentType, page: "1" }))}>清除其他筛选</button></div> : (
        <section className={`content-list ${resource.refreshing ? "is-refreshing" : ""}`} aria-label={`${contentLabel}列表`}><DataModeStamp /><div className="table-scroll"><table className="content-table"><thead><tr><th className="content-table__content">内容</th><th className="content-table__analysis">情感 / 风险</th><th className="content-table__engagement">互动</th><th className="content-table__published">发布时间</th><th className="content-table__actions">操作</th></tr></thead><tbody>{resource.data.items.map((item: ContentSummary) => <tr key={`${item.contentType}-${item.id}`}><td className="content-table__content"><strong>{item.title ?? (item.contentType === "COMMENT" ? "评论原文" : "无标题帖子")}</strong><p>{item.excerpt ?? "原文内容缺失"}</p><small>{item.authorDisplayName ?? "作者信息缺失"} · {enumLabel(item.effectiveAnalysis.analysisOrigin)}</small></td><td className="content-table__analysis"><div><StatusBadge value={item.effectiveAnalysis.sentiment} /><StatusBadge value={item.effectiveAnalysis.riskLevel} /></div></td><td className="content-table__engagement"><span>点赞 {formatNumber(item.likedCount)}</span><span>评论 {formatNumber(item.commentCount)}</span></td><td className="content-table__published"><time>{formatDateTime(item.publishedAt)}</time></td><td className="content-table__actions"><div><Link className="text-link" to={`/content/${item.contentType}/${item.id}`}>查看详情</Link><OriginalLink sourceUrl={item.sourceUrl} canOpen={item.canOpenOriginal} /></div></td></tr>)}</tbody></table></div></section>
      )}
      {pagination.totalPages > 0 ? <nav className="pagination content-pagination" aria-label="内容分页"><span>共{pagination.totalItems}条，每页10条</span><div><button className="button button--quiet" type="button" disabled={pagination.page <= 1} onClick={() => setPage(pagination.page - 1)}>上一页</button>{visiblePages(pagination.page, pagination.totalPages).map((page, index) => page === "ellipsis" ? <span className="pagination__ellipsis" aria-hidden="true" key={`ellipsis-${index}`}>…</span> : <button className={`pagination__page ${page === pagination.page ? "is-active" : ""}`} type="button" aria-current={page === pagination.page ? "page" : undefined} onClick={() => setPage(page)} key={page}>{page}</button>)}<button className="button button--quiet" type="button" disabled={pagination.page >= pagination.totalPages} onClick={() => setPage(pagination.page + 1)}>下一页</button></div></nav> : null}
    </>
  );
}
