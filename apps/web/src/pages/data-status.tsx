import { useMemo, useState, type ReactNode } from "react";
import { ApiError, api } from "../api/client";
import { EmptyState, ErrorNotice, Panel, StatusBadge } from "../components/common";
import { PageHeader, SkeletonPage } from "../components/page";
import { useResource } from "../hooks/use-resource";
import { errorMessage, formatDateTime } from "../utils/format";

export function DataStatusPage(): ReactNode {
  const search = useMemo(() => new URLSearchParams("page=1&pageSize=50&sortOrder=DESC"), []);
  const resource = useResource(useMemo(() => () => api.getTasks(search), [search]), []);
  const [message, setMessage] = useState<string | null>(null);
  const retryTask = async (taskId: string) => {
    setMessage(null);
    try { const response = await api.retryTask(taskId); setMessage(`重试任务已创建：${response.data.id}`); resource.retry(); }
    catch (error) { setMessage(error instanceof ApiError && error.code === "COLLECTION_ALREADY_RUNNING" ? "该品牌已有任务正在运行，不能重复创建。" : errorMessage(error)); }
  };

  if (resource.loading) return <><PageHeader eyebrow="采集运行记录" title="数据状态" description="确认每小时采集是否成功，以及当前数据是否完整。" /><SkeletonPage /></>;
  if (!resource.data) return <><PageHeader eyebrow="采集运行记录" title="数据状态" description="确认每小时采集是否成功，以及当前数据是否完整。" /><ErrorNotice error={resource.error} retry={resource.retry} /></>;
  const data = resource.data;
  const hasSummary = data.consecutiveFailureCount !== undefined && data.volumeAnomaly !== undefined;
  const hasAlert = hasSummary && (data.consecutiveFailureCount! > 0 || data.volumeAnomaly);
  return <><PageHeader eyebrow="采集运行记录" title="数据状态" description="失败任务通过新任务重试，原任务记录保持不变。" />{resource.error ? <ErrorNotice error={resource.error} retry={resource.retry} compact /> : null}{hasSummary ? hasAlert ? <div className="notice notice--error" role="alert"><span className="notice__icon" aria-hidden="true">!</span><div><strong>{data.volumeAnomaly ? "最近数据量出现异常下降" : "采集连续失败"}</strong><p>连续失败{data.consecutiveFailureCount}次，最后成功时间为{formatDateTime(data.lastSuccessfulCollectionAt ?? null)}。</p></div></div> : <div className="notice notice--success"><span aria-hidden="true">✓</span><p>最近采集运行正常，最后成功时间为{formatDateTime(data.lastSuccessfulCollectionAt ?? null)}。</p></div> : <div className="notice"><p>采集汇总状态暂不可用，请以下方任务记录为准。</p></div>}{message ? <div className="notice" role="status"><p>{message}</p></div> : null}<Panel title="24小时采集心跳" caption="图标和文字共同表达状态"><div className="heartbeat" role="img" aria-label="最近采集任务状态带，下方任务表提供完整数据">{data.items.slice(0, 24).map((task) => <span key={task.id} className={`heartbeat__cell is-${task.status.toLowerCase()}`} title={`${task.id}：${task.status}`}><b>{task.status === "SUCCESS" ? "✓" : task.status === "FAILED" ? "!" : task.status === "PARTIAL_SUCCESS" ? "△" : "·"}</b><small>{formatDateTime(task.startedAt).slice(-5)}</small></span>)}</div></Panel><Panel title="任务台账" caption={`共${data.pagination.totalItems}条记录`}>{data.items.length ? <div className="table-scroll"><table><thead><tr><th>任务编号</th><th>品牌编号</th><th>触发方式</th><th>开始时间</th><th>状态</th><th>成功帖子</th><th>失败帖子</th><th>错误摘要</th><th>操作</th></tr></thead><tbody>{data.items.map((task) => <tr key={task.id}><td className="numeric">{task.id}</td><td>{task.brandId}</td><td>{task.triggerType}</td><td>{formatDateTime(task.startedAt)}</td><td><StatusBadge value={task.status} /></td><td>{task.succeededPostCount}</td><td>{task.failedPostCount}</td><td className="error-summary">{task.errorSummary ?? "无"}</td><td>{task.status === "FAILED" || task.status === "PARTIAL_SUCCESS" ? <button className="button button--quiet" type="button" onClick={() => void retryTask(task.id)}>重新执行</button> : <span className="muted">不可重试</span>}</td></tr>)}</tbody></table></div> : <EmptyState kind="not-collected" />}</Panel></>;
}
