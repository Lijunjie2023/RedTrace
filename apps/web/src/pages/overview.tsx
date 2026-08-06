import { useMemo, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { DataHealth, EmptyState, ErrorNotice, EvidenceItem, FilterBar, Panel, StatusBadge } from "../components/common";
import { PageHeader, SkeletonPage } from "../components/page";
import { useResource } from "../hooks/use-resource";
import { formatNumber, formatPercent } from "../utils/format";

export function OverviewPage(): ReactNode {
  const [search, setSearch] = useSearchParams();
  const searchKey = search.toString();
  const loader = useMemo(() => () => api.getOverview(new URLSearchParams(searchKey)), [searchKey]);
  const resource = useResource(loader, [searchKey]);
  const navigate = useNavigate();

  if (resource.loading) return <><PageHeader eyebrow="每日风险简报" title="舆情概览" description="从负面变化进入原因和原始证据。" /><SkeletonPage /></>;
  if (!resource.data) return <><PageHeader eyebrow="每日风险简报" title="舆情概览" description="从负面变化进入原因和原始证据。" /><ErrorNotice error={resource.error} retry={resource.retry} /></>;

  const { data } = resource.data;
  const notCollected = data.collectionHealth === "NOT_COLLECTED";
  const maxTrend = Math.max(1, ...data.sentimentTrend.flatMap((point) => [point.positive, point.neutral, point.negative]));
  const drill = (extra: Record<string, string>) => {
    const next = new URLSearchParams(search);
    Object.entries(extra).forEach(([key, value]) => next.set(key, value));
    navigate(`/content?${next.toString()}`);
  };
  const drillTrend = (sentiment: "NEGATIVE" | "POSITIVE" | "NEUTRAL", bucket: string) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(bucket)) {
      drill({ sentiments: sentiment, from: `${bucket}T00:00:00+08:00`, to: `${bucket}T23:59:59+08:00` });
      return;
    }
    drill({ sentiments: sentiment });
  };

  return (
    <>
      <PageHeader eyebrow="每日风险简报" title="舆情概览" description="先看负面是否增加，再核对原因和原始证据。" />
      <FilterBar search={search} setSearch={setSearch} />
      {resource.error ? <ErrorNotice error={resource.error} retry={resource.retry} compact /> : null}
      <DataHealth health={data.collectionHealth} lastSuccessfulAt={data.lastSuccessfulCollectionAt} />
      {notCollected ? <EmptyState kind="not-collected" /> : (
        <div className={`overview-grid ${resource.refreshing ? "is-refreshing" : ""}`}>
          <Panel title="负面风险摘要" caption="当前筛选范围" className="risk-summary">
            <div className="risk-summary__main"><span>负面内容</span><strong>{formatNumber(data.metrics.negativeCount)}</strong><button className="text-link" type="button" onClick={() => drill({ sentiments: "NEGATIVE" })}>查看全部负面证据</button></div>
            <div className="risk-summary__facts"><div><span>负面占比</span><b>{formatPercent(data.metrics.negativeRatio)}</b></div><div><span>帖子</span><b>{formatNumber(data.metrics.postCount)}</b></div><div><span>评论</span><b>{formatNumber(data.metrics.commentCount)}</b></div></div>
            <ol className="topic-spine">{data.risingTopics.slice(0, 3).map((topic, index) => <li key={topic.topicId}><span>0{index + 1}</span><div><b>{topic.topicName}</b><small>{topic.evidenceCount}条证据 · {topic.changeRatio === null ? "缺少环比" : `变化${formatPercent(topic.changeRatio)}`}</small></div><Link to={`/insights?topicId=${encodeURIComponent(topic.topicId)}`}>查看</Link></li>)}</ol>
          </Panel>
          <Panel title="高风险证据" caption="按最近发布时间排列" className="risk-evidence">
            {data.highRiskContents.length ? data.highRiskContents.slice(0, 4).map((item) => <EvidenceItem key={`${item.contentType}-${item.id}`} item={item} />) : <EmptyState kind="filtered" />}
          </Panel>
          <Panel title="情感趋势" caption="选择数据点可进入对应内容" className="trend-panel">
            <div className="legend" aria-label="图例"><span><i className="legend__risk" />负向</span><span><i className="legend__positive" />正向</span><span><i className="legend__neutral" />中性</span></div>
            <div className="trend-chart" role="region" aria-label="情感趋势柱状图，下方表格提供完整数据">{data.sentimentTrend.map((point) => <div className="trend-group" key={point.bucket}><div className="trend-group__bars"><button type="button" title={`${point.bucket}负向${point.negative}条`} aria-label={`查看${point.bucket}负向内容`} onClick={() => drillTrend("NEGATIVE", point.bucket)}><span className="bar bar--negative" style={{ height: `${(point.negative / maxTrend) * 100}%` }} /></button><button type="button" title={`${point.bucket}正向${point.positive}条`} aria-label={`查看${point.bucket}正向内容`} onClick={() => drillTrend("POSITIVE", point.bucket)}><span className="bar bar--positive" style={{ height: `${(point.positive / maxTrend) * 100}%` }} /></button><button type="button" title={`${point.bucket}中性${point.neutral}条`} aria-label={`查看${point.bucket}中性内容`} onClick={() => drillTrend("NEUTRAL", point.bucket)}><span className="bar bar--neutral" style={{ height: `${(point.neutral / maxTrend) * 100}%` }} /></button></div><small>{point.bucket.slice(5)}</small></div>)}</div>
            <details><summary>查看趋势数据表</summary><div className="table-scroll"><table><thead><tr><th>日期</th><th>负向</th><th>正向</th><th>中性</th></tr></thead><tbody>{data.sentimentTrend.map((point) => <tr key={point.bucket}><td>{point.bucket}</td><td>{point.negative}</td><td>{point.positive}</td><td>{point.neutral}</td></tr>)}</tbody></table></div></details>
          </Panel>
          <Panel title="问题与品类排行" caption="点击后进入带筛选条件的内容库" className="ranking-panel">
            <div className="ranking-columns"><div><h3>问题类型</h3>{data.problemTypeRanking.slice(0, 5).map((item, index) => <button type="button" key={item.problemTypeId} onClick={() => drill({ problemTypeIds: item.problemTypeId })}><span>0{index + 1}</span><b>{item.problemTypeName}</b><em>{item.contentCount}</em></button>)}</div><div><h3>产品品类</h3>{data.categoryRanking.slice(0, 5).map((item, index) => <button type="button" key={item.categoryId} onClick={() => drill({ categoryIds: item.categoryId })}><span>0{index + 1}</span><b>{item.categoryName}</b><em>{item.contentCount}</em></button>)}</div></div>
          </Panel>
          <Panel title="品牌覆盖" caption="统计口径与当前筛选一致" className="brand-table"><div className="table-scroll"><table><thead><tr><th>品牌</th><th>内容数</th><th>负面数</th><th>状态</th></tr></thead><tbody>{data.brandRanking.map((brand) => <tr key={brand.brandId}><td>{brand.brandName}</td><td>{brand.contentCount}</td><td>{brand.negativeCount}</td><td><StatusBadge value={brand.negativeCount ? "NEGATIVE" : "NEUTRAL"} /></td></tr>)}</tbody></table></div></Panel>
        </div>
      )}
    </>
  );
}
