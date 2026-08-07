import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { ErrorNotice, Panel } from "../components/common";
import { Icon } from "../components/icons";
import { PageHeader, SkeletonPage } from "../components/page";
import { useResource } from "../hooks/use-resource";
import { formatDateTime, formatNumber, formatPercent } from "../utils/format";

function ClassificationProgress({ label, total, classified }: { label: string; total: number; classified: number }): ReactNode {
  const pending = Math.max(0, total - classified);
  const ratio = total > 0 ? classified / total : 0;
  return <section className="classification-progress"><header><div><span>{label}</span><strong>{formatNumber(total)}</strong><small>已采集总量</small></div><div className="classification-progress__rate"><span>分类完成率</span><strong>{formatPercent(ratio)}</strong></div></header><div className="classification-progress__bar" role="progressbar" aria-label={`${label}分类完成率`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={ratio === null ? undefined : Math.round(ratio * 100)}><i style={{ width: `${(ratio ?? 0) * 100}%` }} /></div><dl><div><dt>AI已分类</dt><dd>{formatNumber(classified)}</dd></div><div><dt>待分类</dt><dd>{formatNumber(pending)}</dd></div></dl></section>;
}

export function DataManagementPage(): ReactNode {
  const resource = useResource(() => api.getDataManagementSummary(), []);
  const [startingAnalysis, setStartingAnalysis] = useState(false);
  const [analysisMessage, setAnalysisMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function triggerAnalysis(): Promise<void> {
    setStartingAnalysis(true);
    setAnalysisMessage(null);
    try {
      const response = await api.triggerAnalysis();
      setAnalysisMessage(response.data.started
        ? { tone: "success", text: "分析任务已经启动" }
        : { tone: "success", text: "当前已有分析任务正在运行" });
      resource.retry();
    } catch {
      setAnalysisMessage({ tone: "error", text: "分析任务启动失败，请稍后重试。" });
    } finally {
      setStartingAnalysis(false);
    }
  }

  const header = <PageHeader eyebrow="数据资产总览" title="数据管理" description="查看采集规模、AI分类进度和需要处理的分析异常。" action={<button className="button button--primary" type="button" disabled={startingAnalysis} onClick={() => void triggerAnalysis()}>{startingAnalysis ? "正在启动" : "立即分析"}</button>} />;
  if (resource.loading) return <>{header}<SkeletonPage /></>;
  if (!resource.data) return <>{header}<ErrorNotice error={resource.error} retry={resource.retry} /></>;
  const data = resource.data.data;
  const total = data.totalPosts + data.totalComments;
  const classified = data.aiClassifiedPosts + data.aiClassifiedComments;
  const overallRatio = total > 0 ? classified / total : 0;
  return <>{header}{analysisMessage ? <div className={`notice notice--${analysisMessage.tone}`} role={analysisMessage.tone === "error" ? "alert" : "status"}><p>{analysisMessage.text}</p></div> : null}{resource.error ? <ErrorNotice error={resource.error} retry={resource.retry} compact /> : null}<div className="data-management-grid">
    <Panel title="AI分类进度" caption={`全部内容共${formatNumber(total)}条`} className="classification-overview">
      <div className="classification-overview__lead"><span>整体分类完成率</span><strong>{formatPercent(overallRatio)}</strong><small>{formatNumber(classified)}条内容已有AI分类结果</small></div>
      {total === 0 ? <div className="data-management-empty"><Icon name="database" /><div><h3>尚未采集内容</h3><p>完成监控设置并成功采集后，这里会显示帖子、评论和AI分类进度。</p><Link className="button button--primary" to="/brands">前往监控设置</Link></div></div> : <div className="classification-progress-grid"><ClassificationProgress label="帖子" total={data.totalPosts} classified={data.aiClassifiedPosts} /><ClassificationProgress label="评论" total={data.totalComments} classified={data.aiClassifiedComments} /></div>}
    </Panel>
    <Panel title="分析运行状态" caption="失败内容需要检查模型调用或数据质量" className="analysis-status-panel"><div className="status-metric-grid"><div><Icon name="status" /><span>正在分析的内容</span><strong>{formatNumber(data.analysisRunningCount)}</strong><small>当前正在进行AI分类</small></div><div className={data.analysisFailedCount > 0 ? "is-risk" : ""}><Icon name={data.analysisFailedCount > 0 ? "warning" : "check"} /><span>分析失败的内容</span><strong>{formatNumber(data.analysisFailedCount)}</strong><small>{data.analysisFailedCount > 0 ? "需要排查并重新分析" : "当前没有分析失败的内容"}</small></div><div><Icon name="check" /><span>人工修正</span><strong>{formatNumber(data.manualCorrectionCount)}</strong><small>已由人员复核调整</small></div></div></Panel>
    <Panel title="最近分析" caption="AI分类结果的最新更新时间" className="latest-analysis-panel"><div className="latest-analysis"><Icon name="database" /><div><span>最近分析时间</span><strong>{data.lastAnalysisAt ? formatDateTime(data.lastAnalysisAt) : "尚无分析记录"}</strong><small>{data.lastAnalysisAt ? "分类数据已写入数据库" : "完成首次AI分析后将在这里显示时间"}</small></div></div></Panel>
  </div></>;
}
