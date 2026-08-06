import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ApiError, api, type EffectiveAnalysis } from "../api/client";
import { DataModeStamp, ErrorNotice, OriginalLink, StatusBadge } from "../components/common";
import { PageHeader, SkeletonPage } from "../components/page";
import { useResource } from "../hooks/use-resource";
import { useUnsavedChanges } from "../layout/app-shell";
import { enumLabel, errorMessage, formatDateTime, formatNumber } from "../utils/format";

type FormAnalysis = Pick<EffectiveAnalysis, "sentiment" | "contentNature" | "problemTypeIds" | "categoryId" | "productSeries" | "productModel" | "userStage" | "riskLevel" | "topicIds">;

function toForm(value: EffectiveAnalysis): FormAnalysis {
  return {
    sentiment: value.sentiment, contentNature: value.contentNature, problemTypeIds: value.problemTypeIds,
    categoryId: value.categoryId, productSeries: value.productSeries, productModel: value.productModel,
    userStage: value.userStage, riskLevel: value.riskLevel, topicIds: value.topicIds
  };
}

export function ContentDetailPage(): ReactNode {
  const { contentType = "", id = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { confirmNavigation, setHasUnsavedChanges } = useUnsavedChanges();
  const validType = contentType === "POST" || contentType === "COMMENT";
  const resource = useResource(useMemo(() => () => validType ? api.getContent(contentType, id) : Promise.reject(new Error("内容类型无效")), [validType, contentType, id]), [validType, contentType, id]);
  const [form, setForm] = useState<FormAnalysis | null>(null);
  const [version, setVersion] = useState(1);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    if (resource.data) {
      setForm(toForm(resource.data.data.effectiveAnalysis));
      setVersion(resource.data.data.effectiveAnalysis.version);
    }
  }, [resource.data]);

  const dirty = resource.data && form ? JSON.stringify(form) !== JSON.stringify(toForm(resource.data.data.effectiveAnalysis)) : false;
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    setHasUnsavedChanges(dirty);
    return () => setHasUnsavedChanges(false);
  }, [dirty, setHasUnsavedChanges]);

  useEffect(() => {
    if (!dirty) return;
    const currentLocation = `${location.pathname}${location.search}${location.hash}`;
    const guardLink = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank") return;
      const target = new URL(anchor.href, window.location.href);
      if (target.origin !== window.location.origin || `${target.pathname}${target.search}${target.hash}` === currentLocation) return;
      if (!confirmNavigation()) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const guardHistory = () => {
      if (!confirmNavigation()) window.setTimeout(() => navigate(currentLocation, { replace: true }), 0);
    };
    document.addEventListener("click", guardLink, true);
    window.addEventListener("popstate", guardHistory);
    return () => {
      document.removeEventListener("click", guardLink, true);
      window.removeEventListener("popstate", guardHistory);
    };
  }, [confirmNavigation, dirty, location.hash, location.pathname, location.search, navigate]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!form) return;
    setSaving(true); setSaveMessage(null);
    try {
      const response = await api.correctContent(contentType, id, version, form);
      setForm(toForm(response.data)); setVersion(response.data.version); setSaveMessage("修正已保存，汇总将使用当前有效结果。"); resource.retry();
    } catch (error) {
      setSaveMessage(error instanceof ApiError && error.code === "VERSION_CONFLICT" ? "数据已经变化，请重新加载后再提交。" : errorMessage(error));
    } finally { setSaving(false); }
  };

  if (resource.loading) return <><PageHeader eyebrow="证据详情" title="内容详情" description="核对原文、上下文、模型结果和人工修正。" /><SkeletonPage /></>;
  if (!resource.data || !form) return <><PageHeader eyebrow="证据详情" title="内容详情" description="核对原文、上下文、模型结果和人工修正。" /><ErrorNotice error={resource.error} retry={resource.retry} /></>;
  const detail = resource.data.data;
  const model = detail.modelAnalysis;

  return (
    <>
      <PageHeader eyebrow="证据详情" title={detail.title ?? (detail.contentType === "COMMENT" ? "评论原文" : "无标题帖子")} description="原文证据与分析结果分区展示。" action={<button className="button button--quiet" type="button" onClick={() => { if (confirmNavigation()) navigate(-1); }}>返回来源页</button>} />
      {resource.error ? <ErrorNotice error={resource.error} retry={resource.retry} compact /> : null}
      <div className="detail-layout">
        <article className="detail-original"><DataModeStamp /><div className="detail-meta"><StatusBadge value={detail.effectiveAnalysis.riskLevel} /><span>{enumLabel(detail.contentType)}</span><span>{formatDateTime(detail.publishedAt)}</span></div><p className="detail-full-text">{detail.fullText ?? detail.excerpt ?? "原文内容缺失"}</p><dl className="evidence-facts"><div><dt>作者公开信息</dt><dd>{detail.authorDisplayName ?? "缺失"}</dd></div><div><dt>点赞</dt><dd>{formatNumber(detail.likedCount)}</dd></div><div><dt>首次采集</dt><dd>{formatDateTime(detail.firstCollectedAt)}</dd></div><div><dt>最后更新</dt><dd>{formatDateTime(detail.lastCollectedAt)}</dd></div></dl><OriginalLink sourceUrl={detail.sourceUrl} canOpen={detail.canOpenOriginal} /></article>
        <aside className="context-rail"><h2>上下文与证据</h2>{detail.parentCommentId ? <p>父评论编号：{detail.parentCommentId}</p> : null}{detail.context.length ? detail.context.map((item) => <article key={`${item.contentType}-${item.contentId}`}><span>{enumLabel(item.contentType)}</span><p>{item.excerpt ?? "内容缺失"}</p><Link to={`/content/${item.contentType}/${item.contentId}`}>查看上下文</Link></article>) : <p className="muted">当前内容没有附加上下文。</p>}</aside>
        <form className="correction-panel" onSubmit={(event) => void save(event)}><header><span>人工修正</span><h2>当前有效结果</h2><p>模型原始结果保持只读，保存后使用人工结果。</p></header>{saveMessage ? <div className={`notice ${saveMessage.includes("已保存") ? "notice--success" : "notice--error"}`} role="status"><p>{saveMessage}</p></div> : null}<div className="model-snapshot"><span>模型原始结果</span>{model ? <><StatusBadge value={model.sentiment} /><StatusBadge value={model.riskLevel} /><small>{model.modelName ?? "模型名称缺失"} · {formatDateTime(model.analyzedAt)}</small></> : <p>暂无模型分析</p>}</div><label><span>情感倾向</span><select value={form.sentiment} onChange={(e) => setForm({ ...form, sentiment: e.target.value as FormAnalysis["sentiment"] })}><option value="POSITIVE">正向</option><option value="NEUTRAL">中性</option><option value="NEGATIVE">负向</option><option value="UNKNOWN">无法判断</option></select></label><label><span>风险程度</span><select value={form.riskLevel} onChange={(e) => setForm({ ...form, riskLevel: e.target.value as FormAnalysis["riskLevel"] })}><option value="NORMAL">普通</option><option value="WATCH">关注</option><option value="HIGH_RISK">高风险</option></select></label><label><span>内容性质</span><input value={form.contentNature ?? ""} onChange={(e) => setForm({ ...form, contentNature: e.target.value || null })} /></label><label><span>问题类型编号</span><input value={form.problemTypeIds.join(",")} onChange={(e) => setForm({ ...form, problemTypeIds: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) })} /><small>多个编号使用逗号分隔</small></label><label><span>产品品类编号</span><input value={form.categoryId ?? ""} onChange={(e) => setForm({ ...form, categoryId: e.target.value || null })} /></label><label><span>产品系列</span><input value={form.productSeries ?? ""} onChange={(e) => setForm({ ...form, productSeries: e.target.value || null })} /></label><label><span>产品型号</span><input value={form.productModel ?? ""} onChange={(e) => setForm({ ...form, productModel: e.target.value || null })} /></label><label><span>用户阶段</span><input value={form.userStage ?? ""} onChange={(e) => setForm({ ...form, userStage: e.target.value || null })} /></label><button className="button button--primary button--wide" type="submit" disabled={saving || !dirty}>{saving ? "正在保存" : dirty ? "保存修正" : "没有待保存修改"}</button></form>
      </div>
    </>
  );
}
