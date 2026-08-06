import { useMemo, type KeyboardEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, type OverviewData } from "../api/client";
import { DataHealth, EmptyState, ErrorNotice, EvidenceItem, FilterBar, Panel } from "../components/common";
import { PageHeader, SkeletonPage } from "../components/page";
import { Icon } from "../components/icons";
import { useResource } from "../hooks/use-resource";
import { formatNumber, formatPercent } from "../utils/format";

type TrendPoint = OverviewData["sentimentTrend"][number];
type TrendKey = "negative" | "positive" | "neutral";

function TrendChart({ points, onDrill }: { points: TrendPoint[]; onDrill: (sentiment: "NEGATIVE" | "POSITIVE" | "NEUTRAL", bucket: string) => void }): ReactNode {
  if (!points.length) return <EmptyState kind="filtered" />;

  const width = 720;
  const height = 240;
  const paddingX = 28;
  const paddingY = 22;
  const max = Math.max(1, ...points.flatMap((point) => [point.negative, point.positive, point.neutral]));
  const x = (index: number) => points.length === 1 ? width / 2 : paddingX + (index / (points.length - 1)) * (width - paddingX * 2);
  const y = (value: number) => height - paddingY - (value / max) * (height - paddingY * 2);
  const series: Array<{ key: TrendKey; sentiment: "NEGATIVE" | "POSITIVE" | "NEUTRAL"; label: string }> = [
    { key: "negative", sentiment: "NEGATIVE", label: "负向" },
    { key: "positive", sentiment: "POSITIVE", label: "正向" },
    { key: "neutral", sentiment: "NEUTRAL", label: "中性" }
  ];
  const path = (key: TrendKey) => points.map((point, index) => `${index ? "L" : "M"}${x(index)},${y(point[key])}`).join(" ");
  const activate = (event: KeyboardEvent<SVGCircleElement>, sentiment: "NEGATIVE" | "POSITIVE" | "NEUTRAL", bucket: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onDrill(sentiment, bucket);
    }
  };

  return (
    <div className="trend-visual" role="region" aria-label="情感趋势折线图，下方表格提供完整数据">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="false">
        <title>情感趋势，数据点可以使用键盘进入对应内容</title>
        {[0.25, 0.5, 0.75, 1].map((ratio) => <line key={ratio} className="trend-gridline" x1={paddingX} x2={width - paddingX} y1={y(max * ratio)} y2={y(max * ratio)} />)}
        {series.map(({ key, sentiment, label }) => <g key={key} className={`trend-series trend-series--${key}`}><path d={path(key)} />{points.map((point, index) => <circle key={point.bucket} cx={x(index)} cy={y(point[key])} r="5" role="button" tabIndex={0} aria-label={`查看${point.bucket}${label}${point[key]}条内容`} onClick={() => onDrill(sentiment, point.bucket)} onKeyDown={(event) => activate(event, sentiment, point.bucket)}><title>{point.bucket} · {label}{point[key]}条</title></circle>)}</g>)}
      </svg>
      <div className="trend-axis" aria-hidden="true">{points.map((point) => <span key={point.bucket}>{point.bucket.slice(5)}</span>)}</div>
      <span className="trend-scroll-hint">趋势图可以左右滑动，完整数值见下方数据表</span>
    </div>
  );
}

function RankingPanel({ title, caption, items, onSelect }: { title: string; caption: string; items: Array<{ id: string; name: string; count: number }>; onSelect: (id: string) => void }): ReactNode {
  return <Panel title={title} caption={caption} className="compact-ranking">{items.length ? <ol>{items.slice(0, 6).map((item, index) => <li key={item.id}><button type="button" onClick={() => onSelect(item.id)}><span>{String(index + 1).padStart(2, "0")}</span><b>{item.name}</b><em>{formatNumber(item.count)}</em><Icon name="arrow" /></button></li>)}</ol> : <EmptyState kind="analysis" />}</Panel>;
}

export function OverviewPage(): ReactNode {
  const [search, setSearch] = useSearchParams();
  const searchKey = search.toString();
  const loader = useMemo(() => () => api.getOverview(new URLSearchParams(searchKey)), [searchKey]);
  const resource = useResource(loader, [searchKey]);
  const navigate = useNavigate();
  const header = <PageHeader eyebrow="每日风险简报" title="舆情概览" description="先看负面变化，再定位问题原因并回到原始证据。" />;

  if (resource.loading) return <>{header}<SkeletonPage /></>;
  if (!resource.data) return <>{header}<ErrorNotice error={resource.error} retry={resource.retry} /></>;

  const { data } = resource.data;
  const notCollected = data.collectionHealth === "NOT_COLLECTED";
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
      {header}
      <FilterBar search={search} setSearch={setSearch} />
      {resource.error ? <><ErrorNotice error={resource.error} retry={resource.retry} compact /><div className="notice notice--stale" role="status"><Icon name="info" /><strong>下方为上一次成功查询结果，未按当前筛选更新。</strong></div></> : null}
      {notCollected ? <EmptyState kind="not-collected" /> : (
        <div className={`overview-grid ${resource.refreshing ? "is-refreshing" : ""}`} aria-busy={resource.refreshing}>
          {resource.refreshing ? <div className="refresh-status" role="status"><span />正在更新数据，当前结果仍可查看</div> : null}
          <Panel title="负面问题变化" caption="点击数据点查看对应原始内容" className="trend-panel">
            <div className="trend-panel__topline"><div className="legend" aria-label="图例"><span><i className="legend__risk" />负向</span><span><i className="legend__positive" />正向</span><span><i className="legend__neutral" />中性</span></div><button className="text-link" type="button" onClick={() => drill({ sentiments: "NEGATIVE" })}>查看全部负面证据</button></div>
            <TrendChart points={data.sentimentTrend} onDrill={drillTrend} />
            <div className="metric-ribbon"><div><span>负面内容</span><strong>{formatNumber(data.metrics.negativeCount)}</strong></div><div><span>负面占比</span><strong>{formatPercent(data.metrics.negativeRatio)}</strong></div><div><span>帖子</span><strong>{formatNumber(data.metrics.postCount)}</strong></div><div><span>评论</span><strong>{formatNumber(data.metrics.commentCount)}</strong></div></div>
            <details className="trend-table"><summary>查看趋势数据表</summary><div className="table-scroll"><table><thead><tr><th>日期</th><th>负向</th><th>正向</th><th>中性</th><th>无法判断</th></tr></thead><tbody>{data.sentimentTrend.map((point) => <tr key={point.bucket}><td>{point.bucket}</td><td>{point.negative}</td><td>{point.positive}</td><td>{point.neutral}</td><td>{point.unknown}</td></tr>)}</tbody></table></div></details>
          </Panel>
          <Panel title="热门问题" caption="按证据数量" className="rising-topics">
            {data.risingTopics.length ? <ol>{[...data.risingTopics].sort((left, right) => right.evidenceCount - left.evidenceCount).slice(0, 7).map((topic, index) => <li key={topic.topicId}><Link to={`/insights?topicId=${encodeURIComponent(topic.topicId)}`}><span>{index + 1}</span><b>{topic.topicName}</b>{topic.changeRatio !== null ? <em>{formatPercent(topic.changeRatio)}</em> : null}<small>{formatNumber(topic.evidenceCount)}条证据</small><Icon name="arrow" /></Link></li>)}</ol> : <EmptyState kind="analysis" />}
          </Panel>
          <Panel title="代表性原话" caption="高风险内容优先" className="risk-evidence">
            {data.highRiskContents.length ? data.highRiskContents.slice(0, 4).map((item) => <EvidenceItem key={`${item.contentType}-${item.id}`} item={item} />) : <div className="evidence-empty"><strong>当前范围没有高风险证据</strong><p>这是一项正常的业务结果，可以继续查看全部内容。</p><Link className="text-link" to="/content">查看内容库</Link></div>}
          </Panel>
          <RankingPanel title="品牌负面排行" caption="内容量与负面量" items={data.brandRanking.map((item) => ({ id: item.brandId, name: item.brandName, count: item.negativeCount }))} onSelect={(id) => drill({ brandIds: id, sentiments: "NEGATIVE" })} />
          <RankingPanel title="产品品类排行" caption="按内容数量排序" items={data.categoryRanking.map((item) => ({ id: item.categoryId, name: item.categoryName, count: item.contentCount }))} onSelect={(id) => drill({ categoryIds: id })} />
          <RankingPanel title="问题类型排行" caption="按内容数量排序" items={data.problemTypeRanking.map((item) => ({ id: item.problemTypeId, name: item.problemTypeName, count: item.contentCount }))} onSelect={(id) => drill({ problemTypeIds: id })} />
          <DataHealth health={data.collectionHealth} lastSuccessfulAt={data.lastSuccessfulCollectionAt} />
        </div>
      )}
    </>
  );
}
