import { useMemo, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, type OverviewData } from "../api/client";
import { DataHealth, EmptyState, ErrorNotice, EvidenceItem, FilterBar, Panel } from "../components/common";
import { PageHeader, SkeletonPage } from "../components/page";
import { Icon } from "../components/icons";
import { useResource } from "../hooks/use-resource";
import { enumLabel, formatDateTime, formatNumber, formatPercent } from "../utils/format";

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

function CategoryProblemComparison({ data, onDrill }: { data: OverviewData; onDrill: (filter: Record<string, string>) => void }): ReactNode {
  const categories = data.categoryRanking.slice(0, 5);
  const problems = data.problemTypeRanking.slice(0, 5);
  const maxCategoryCount = Math.max(1, ...categories.map((item) => item.contentCount));
  return (
    <Panel title="品类内容与问题对比" caption="展示已采集内容量；点击后查看相关帖子" className="category-problem-panel">
      <div className="category-problem-layout">
        <section aria-labelledby="category-comparison-heading">
          <header className="comparison-heading"><span id="category-comparison-heading">产品品类</span><small>内容量</small></header>
          {categories.length ? <div className="category-comparison">{categories.map((item) => <button key={item.categoryId} type="button" onClick={() => onDrill({ categoryIds: item.categoryId })}><span className="category-comparison__name">{item.categoryName}</span><strong>{formatNumber(item.contentCount)}</strong><i aria-hidden="true"><b style={{ "--bar-size": `${(item.contentCount / maxCategoryCount) * 100}%` } as CSSProperties} /></i><small>查看相关帖子<Icon name="arrow" /></small></button>)}</div> : <EmptyState kind="analysis" />}
        </section>
        <section className="problem-comparison" aria-labelledby="problem-comparison-heading">
          <header className="comparison-heading"><span id="problem-comparison-heading">主要问题类型</span><small>内容量</small></header>
          {problems.length ? <ol>{problems.map((item, index) => <li key={item.problemTypeId}><button type="button" onClick={() => onDrill({ problemTypeIds: item.problemTypeId })}><span>{String(index + 1).padStart(2, "0")}</span><b>{item.problemTypeName}</b><em>{formatNumber(item.contentCount)}</em><Icon name="arrow" /></button></li>)}</ol> : <EmptyState kind="analysis" />}
        </section>
      </div>
      <p className="panel-footnote"><Icon name="info" />当前仅展示真实内容基数，暂不提供分品类负面数量；评论可以在内容明细中切换查看。</p>
    </Panel>
  );
}

function SentimentComposition({ data }: { data: OverviewData }): ReactNode {
  const totals = data.sentimentTrend.reduce((sum, point) => ({
    positive: sum.positive + point.positive,
    neutral: sum.neutral + point.neutral,
    negative: sum.negative + point.negative,
    unknown: sum.unknown + point.unknown
  }), { positive: 0, neutral: 0, negative: 0, unknown: 0 });
  const total = totals.positive + totals.neutral + totals.negative + totals.unknown;
  const metricTotal = data.metrics.postCount === null || data.metrics.commentCount === null
    ? null
    : data.metrics.postCount + data.metrics.commentCount;
  const trendNegativeRatio = total ? totals.negative / total : null;
  const contractRatio = data.metrics.negativeRatio;
  const ratiosMatch = metricTotal !== null && total === metricTotal
    && trendNegativeRatio !== null && contractRatio !== null
    && Math.abs(trendNegativeRatio - contractRatio) <= 0.01;
  if (!total) return <Panel title="情感构成" caption="按当前筛选范围"><EmptyState kind="filtered" /></Panel>;
  if (!ratiosMatch) return <Panel title="情感构成" caption="按当前筛选范围" className="sentiment-panel"><div className="composition-unavailable"><Icon name="info" /><strong>暂不展示占比图</strong><p>趋势与总览的统计口径不同，保留原始数量，避免产生误导。</p></div></Panel>;

  const negativeEnd = (totals.negative / total) * 100;
  const positiveEnd = negativeEnd + (totals.positive / total) * 100;
  const neutralEnd = positiveEnd + (totals.neutral / total) * 100;
  const chartStyle = {
    "--negative-end": `${negativeEnd}%`,
    "--positive-end": `${positiveEnd}%`,
    "--neutral-end": `${neutralEnd}%`
  } as CSSProperties;
  return (
    <Panel title="情感构成" caption="趋势汇总与总览口径已核对" className="sentiment-panel">
      <div className="sentiment-composition">
        <div className="sentiment-donut" style={chartStyle} role="img" aria-label={`负向${formatPercent(contractRatio)}，正向${formatNumber(totals.positive)}条，中性${formatNumber(totals.neutral)}条，无法判断${formatNumber(totals.unknown)}条`}><div><span>负面占比</span><strong>{formatPercent(contractRatio)}</strong></div></div>
        <dl><div><dt><i className="is-negative" />负向</dt><dd>{formatNumber(totals.negative)}</dd></div><div><dt><i className="is-positive" />正向</dt><dd>{formatNumber(totals.positive)}</dd></div><div><dt><i className="is-neutral" />中性</dt><dd>{formatNumber(totals.neutral)}</dd></div>{totals.unknown ? <div><dt><i className="is-unknown" />无法判断</dt><dd>{formatNumber(totals.unknown)}</dd></div> : null}</dl>
      </div>
    </Panel>
  );
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
    if (!next.has("contentType")) next.set("contentType", "POST");
    navigate(`/content?${next.toString()}`);
  };
  const insightHref = (topicId: string) => {
    const next = new URLSearchParams(search);
    next.set("topicId", topicId);
    return `/insights?${next.toString()}`;
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
      <FilterBar search={search} setSearch={setSearch} showSentiment={false} showCategory />
      {resource.error ? <><ErrorNotice error={resource.error} retry={resource.retry} compact /><div className="notice notice--stale" role="status"><Icon name="info" /><strong>下方为上一次成功查询结果，未按当前筛选更新。</strong></div></> : null}
      {notCollected ? <EmptyState kind="not-collected" /> : (
        <div className={`overview-grid ${resource.refreshing ? "is-refreshing" : ""}`} aria-busy={resource.refreshing}>
          {resource.refreshing ? <div className="refresh-status" role="status"><span />正在更新数据，当前结果仍可查看</div> : null}
          <Panel title="负面问题变化" caption="点击数据点查看相关帖子" className="trend-panel">
            <div className="trend-panel__topline"><div className="legend" aria-label="图例"><span><i className="legend__risk" />负向</span><span><i className="legend__positive" />正向</span><span><i className="legend__neutral" />中性</span></div><button className="text-link" type="button" onClick={() => drill({ sentiments: "NEGATIVE" })}>查看负面帖子</button></div>
            <TrendChart points={data.sentimentTrend} onDrill={drillTrend} />
            <div className="metric-ribbon"><div><span>负面内容</span><strong>{formatNumber(data.metrics.negativeCount)}</strong></div><div><span>负面占比</span><strong>{formatPercent(data.metrics.negativeRatio)}</strong></div><div><span>帖子</span><strong>{formatNumber(data.metrics.postCount)}</strong></div><div><span>评论</span><strong>{formatNumber(data.metrics.commentCount)}</strong></div></div>
            <details className="trend-table"><summary>查看趋势数据表</summary><div className="table-scroll"><table><thead><tr><th>日期</th><th>负向</th><th>正向</th><th>中性</th><th>无法判断</th></tr></thead><tbody>{data.sentimentTrend.map((point) => <tr key={point.bucket}><td>{point.bucket}</td><td>{point.negative}</td><td>{point.positive}</td><td>{point.neutral}</td><td>{point.unknown}</td></tr>)}</tbody></table></div></details>
          </Panel>
          <Panel title="问题热榜" caption="按证据数量" className="rising-topics">
            {data.risingTopics.length ? <ol>{[...data.risingTopics].sort((left, right) => right.evidenceCount - left.evidenceCount).slice(0, 7).map((topic, index) => <li key={topic.topicId}><Link to={insightHref(topic.topicId)}><span>{index + 1}</span><b>{topic.topicName}</b>{topic.changeRatio !== null ? <em>较上期{formatPercent(topic.changeRatio)}</em> : null}<small>{formatNumber(topic.evidenceCount)}条证据</small><Icon name="arrow" /></Link></li>)}</ol> : <EmptyState kind="analysis" />}
          </Panel>
          <Panel title="代表性原话" caption="高风险内容优先" className="risk-evidence">
            {data.highRiskContents.length ? data.highRiskContents.slice(0, 4).map((item) => <EvidenceItem key={`${item.contentType}-${item.id}`} item={item} />) : <div className="evidence-empty"><strong>当前范围没有高风险证据</strong><p>这是一项正常的业务结果，可以继续查看相关帖子。</p><Link className="text-link" to="/content?contentType=POST">查看相关帖子</Link></div>}
          </Panel>
          <CategoryProblemComparison data={data} onDrill={drill} />
          <SentimentComposition data={data} />
          <Panel title="数据覆盖与质量" caption="只展示当前能够验证的信息" className="quality-panel">
            <DataHealth health={data.collectionHealth} lastSuccessfulAt={data.lastSuccessfulCollectionAt} />
            <div className="quality-facts"><div><Icon name="database" /><span>内容覆盖</span><strong>{formatNumber((data.metrics.postCount ?? 0) + (data.metrics.commentCount ?? 0))}条</strong><small>帖子与评论</small></div><div><Icon name="check" /><span>页面高风险样本</span><strong>{formatNumber(data.highRiskContents.slice(0, 4).length)}条</strong><small>当前页展示，可逐条回溯</small></div><div><Icon name="status" /><span>采集状态</span><strong>{enumLabel(data.collectionHealth)}</strong><small>{data.lastSuccessfulCollectionAt ? `更新于${formatDateTime(data.lastSuccessfulCollectionAt)}` : "尚无成功采集"}</small></div></div>
          </Panel>
        </div>
      )}
    </>
  );
}
