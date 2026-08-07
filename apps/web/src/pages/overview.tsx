import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, type Evidence, type OverviewData } from "../api/client";
import { DataHealth, EmptyState, ErrorNotice, EvidenceItem, FilterBar, OriginalLink, Panel } from "../components/common";
import { Icon } from "../components/icons";
import { SkeletonPage } from "../components/page";
import { useResource } from "../hooks/use-resource";
import { recentShanghaiRange } from "../utils/date-range";
import { enumLabel, formatDateTime, formatNumber, formatPercent } from "../utils/format";

type TrendPoint = OverviewData["sentimentTrend"][number];
const CATEGORY_DISPLAY_ORDER = ["冰箱", "洗衣机", "空调", "水联网", "厨电", "彩电", "其他"] as const;
const CATEGORY_DISPLAY_INDEX = new Map<string, number>(CATEGORY_DISPLAY_ORDER.map((name, index) => [name, index]));

function overviewSearch(search: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams();
  ["from", "to", "brandIds", "categoryIds"].forEach((key) => {
    const value = search.get(key);
    if (value) next.set(key, value);
  });
  return next;
}

function TrendChart({ points, onDrill }: { points: TrendPoint[]; onDrill: (bucket: string) => void }): ReactNode {
  if (!points.length) return <EmptyState kind="filtered" />;
  const width = 720;
  const height = 240;
  const paddingX = 28;
  const paddingY = 22;
  const max = Math.max(1, ...points.map((point) => point.negative));
  const x = (index: number) => points.length === 1 ? width / 2 : paddingX + (index / (points.length - 1)) * (width - paddingX * 2);
  const y = (value: number) => height - paddingY - (value / max) * (height - paddingY * 2);
  const path = points.map((point, index) => `${index ? "L" : "M"}${x(index)},${y(point.negative)}`).join(" ");
  const labelIndexes = new Set<number>();
  if (points.length <= 7) points.forEach((_, index) => labelIndexes.add(index));
  else {
    const step = Math.ceil((points.length - 1) / 6);
    for (let index = 0; index < points.length; index += step) labelIndexes.add(index);
    labelIndexes.add(points.length - 1);
  }
  const activate = (event: KeyboardEvent<SVGCircleElement>, bucket: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onDrill(bucket);
    }
  };
  return (
    <div className="trend-visual" role="region" aria-label="负面内容趋势折线图，数据点可以进入对应日期的内容">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <title>负面内容趋势，数据点可以使用键盘进入对应内容</title>
        {[0.25, 0.5, 0.75, 1].map((ratio) => <line key={ratio} className="trend-gridline" x1={paddingX} x2={width - paddingX} y1={y(max * ratio)} y2={y(max * ratio)} />)}
        <g className="trend-series trend-series--negative"><path d={path} />{points.map((point, index) => <g key={point.bucket} className="trend-point"><circle className="trend-point__hit" cx={x(index)} cy={y(point.negative)} r="14" role="button" tabIndex={0} aria-label={`查看${point.bucket}负向内容${point.negative}条`} onClick={() => onDrill(point.bucket)} onKeyDown={(event) => activate(event, point.bucket)}><title>{point.bucket} · 负向{point.negative}条</title></circle><circle className="trend-point__marker" cx={x(index)} cy={y(point.negative)} r="5" aria-hidden="true" /></g>)}</g>
      </svg>
      <div className="trend-axis" style={{ "--trend-count": points.length } as CSSProperties} aria-hidden="true">{points.map((point, index) => <span key={point.bucket}>{labelIndexes.has(index) ? point.bucket.slice(5) : ""}</span>)}</div>
    </div>
  );
}

function CategoryComparison({ data }: { data: OverviewData }): ReactNode {
  const categories = [...data.categoryRanking]
    .sort((left, right) => (CATEGORY_DISPLAY_INDEX.get(left.categoryName) ?? Number.MAX_SAFE_INTEGER) - (CATEGORY_DISPLAY_INDEX.get(right.categoryName) ?? Number.MAX_SAFE_INTEGER))
    .slice(0, 6);
  const maxCategoryCount = Math.max(1, ...categories.map((item) => item.contentCount));
  return (
    <Panel title="品类内容对比" caption="当前日期与品牌范围" className="category-problem-panel">
      {categories.length ? <div className="category-dashboard-layout"><div className="category-dashboard-labels" aria-hidden="true"><span>品类</span><span>当前内容量</span><span>相对量级</span><span>负面占比</span><span>主要问题</span></div><div className="category-dashboard-grid" style={{ "--category-count": categories.length } as CSSProperties}>{categories.map((item) => {
        return <article key={item.categoryId} className="category-dashboard-column">
          <span className="category-comparison__name">{item.categoryName}</span>
          <strong>{formatNumber(item.contentCount)}</strong>
          <i aria-label={`相对量级${formatPercent(item.contentCount / maxCategoryCount)}`}><b style={{ "--bar-size": `${(item.contentCount / maxCategoryCount) * 100}%` } as CSSProperties} /></i>
          <span className="category-dashboard-value is-unavailable">待统计</span>
          <span className="category-dashboard-value is-unavailable">待统计</span>
        </article>;
      })}</div></div> : <EmptyState kind="analysis" />}
      <p className="panel-footnote"><Icon name="info" />品类区域展示当前日期与品牌范围的完整分布；负面占比和主要问题待统计。</p>
    </Panel>
  );
}

function SentimentComposition({ data }: { data: OverviewData }): ReactNode {
  const totals = data.sentimentTrend.reduce((sum, point) => ({ positive: sum.positive + point.positive, neutral: sum.neutral + point.neutral, negative: sum.negative + point.negative, unknown: sum.unknown + point.unknown }), { positive: 0, neutral: 0, negative: 0, unknown: 0 });
  const total = totals.positive + totals.neutral + totals.negative + totals.unknown;
  const metricTotal = data.metrics.postCount === null || data.metrics.commentCount === null ? null : data.metrics.postCount + data.metrics.commentCount;
  const trendNegativeRatio = total ? totals.negative / total : null;
  const contractRatio = data.metrics.negativeRatio;
  const ratiosMatch = metricTotal !== null && total === metricTotal && trendNegativeRatio !== null && contractRatio !== null && Math.abs(trendNegativeRatio - contractRatio) <= 0.01;
  if (!total) return <Panel title="情感构成" caption="按当前筛选范围" className="sentiment-panel"><div className="sentiment-composition sentiment-composition--empty"><div className="sentiment-donut is-empty" role="img" aria-label="暂无情感数据"><div><strong>暂无数据</strong></div></div><p>当前筛选范围内没有可用内容</p></div></Panel>;
  if (!ratiosMatch) return <Panel title="情感构成" caption="按当前筛选范围" className="sentiment-panel"><div className="sentiment-composition sentiment-composition--empty"><div className="sentiment-donut is-empty" role="img" aria-label="情感占比暂不可用"><div><strong>暂不可用</strong></div></div><p>统计口径尚未对齐，暂不展示可能产生误导的比例</p></div></Panel>;
  const negativeEnd = (totals.negative / total) * 100;
  const positiveEnd = negativeEnd + (totals.positive / total) * 100;
  const neutralEnd = positiveEnd + (totals.neutral / total) * 100;
  const chartStyle = { "--negative-end": `${negativeEnd}%`, "--positive-end": `${positiveEnd}%`, "--neutral-end": `${neutralEnd}%` } as CSSProperties;
  return <Panel title="情感构成" caption="当前筛选范围" className="sentiment-panel"><div className="sentiment-composition"><div className="sentiment-donut" style={chartStyle} role="img" aria-label={`负向${formatPercent(contractRatio)}，正向${formatNumber(totals.positive)}条，中性${formatNumber(totals.neutral)}条`}><div><span>负面占比</span><strong>{formatPercent(contractRatio)}</strong></div></div><dl><div><dt><i className="is-negative" />负向</dt><dd>{formatNumber(totals.negative)}</dd></div><div><dt><i className="is-positive" />正向</dt><dd>{formatNumber(totals.positive)}</dd></div><div><dt><i className="is-neutral" />中性</dt><dd>{formatNumber(totals.neutral)}</dd></div>{totals.unknown ? <div><dt><i className="is-unknown" />无法判断</dt><dd>{formatNumber(totals.unknown)}</dd></div> : null}</dl></div></Panel>;
}

function TopicEvidenceItem({ item }: { item: Evidence }): ReactNode {
  return <article className="evidence-item topic-evidence-item"><div className="evidence-item__meta"><span className="evidence-label">相关原话</span><span>{enumLabel(item.contentType)}</span><span>{formatDateTime(item.publishedAt)}</span></div><p className="clamp-3">{item.excerpt ?? "原文内容缺失"}</p><div className="evidence-item__footer"><span>{item.authorDisplayName ?? "匿名用户"}</span><span>点赞{formatNumber(item.likedCount)}</span><Link to={`/content/${item.contentType}/${item.contentId}`}>查看证据</Link><OriginalLink sourceUrl={item.sourceUrl} canOpen={item.canOpenOriginal} label="打开原文" /></div></article>;
}

function EvidencePanel({ defaultItems, topicId, topicName, filters }: { defaultItems: OverviewData["highRiskContents"]; topicId: string | null; topicName: string | null; filters: URLSearchParams }): ReactNode {
  const filterKey = filters.toString();
  const loader = useMemo(() => () => topicId ? api.getTopicEvidence(topicId, new URLSearchParams(filterKey)) : Promise.resolve(null), [topicId, filterKey]);
  const evidence = useResource(loader, [topicId, filterKey]);
  let body: ReactNode;
  if (!topicId) body = defaultItems.length ? defaultItems.slice(0, 4).map((item) => <EvidenceItem key={`${item.contentType}-${item.id}`} item={item} />) : <EmptyState kind="analysis" />;
  else if (evidence.loading) body = <div className="evidence-loading" role="status"><span className="loading-mark" />正在读取相关原话</div>;
  else if (evidence.error || !evidence.data) body = <ErrorNotice error={evidence.error} retry={evidence.retry} compact />;
  else body = evidence.data.items.length ? evidence.data.items.slice(0, 4).map((item) => <TopicEvidenceItem key={`${item.contentType}-${item.contentId}`} item={item} />) : <EmptyState kind="filtered" />;
  return <Panel title="代表性原话" caption={topicName ? `当前问题：${topicName}` : "高风险内容优先"} className="risk-evidence"><div className="risk-evidence__body">{body}</div></Panel>;
}

export function OverviewPage(): ReactNode {
  const [search, setSearch] = useSearchParams();
  const searchKey = search.toString();
  const defaultFilters = useMemo(() => recentShanghaiRange(), []);
  const defaultKey = defaultFilters.toString();
  const appliedSearch = useMemo(() => {
    const next = new URLSearchParams(searchKey);
    if (!next.has("from")) next.set("from", defaultFilters.get("from")!);
    if (!next.has("to")) next.set("to", defaultFilters.get("to")!);
    return next;
  }, [searchKey, defaultKey]);
  const appliedKey = appliedSearch.toString();
  const [draftSearch, setDraftSearch] = useState(() => new URLSearchParams(appliedSearch));
  useEffect(() => {
    if (appliedKey !== searchKey) setSearch(appliedSearch, { replace: true });
  }, [appliedKey, searchKey, setSearch]);
  useEffect(() => setDraftSearch(new URLSearchParams(appliedKey)), [appliedKey]);
  const overviewFilters = overviewSearch(appliedSearch);
  const overviewKey = overviewFilters.toString();
  const loader = useMemo(() => () => api.getOverview(new URLSearchParams(overviewKey)), [overviewKey]);
  const resource = useResource(loader, [overviewKey]);
  const navigate = useNavigate();
  const selectedTopicId = appliedSearch.get("topicId");

  if (resource.loading) return <><FilterBar search={appliedSearch} setSearch={setSearch} draftSearch={draftSearch} setDraftSearch={setDraftSearch} showSentiment={false} showCategory deferred defaultSearch={defaultFilters} sticky /><SkeletonPage /></>;
  if (!resource.data) return <><FilterBar search={appliedSearch} setSearch={setSearch} draftSearch={draftSearch} setDraftSearch={setDraftSearch} showSentiment={false} showCategory deferred defaultSearch={defaultFilters} sticky /><ErrorNotice error={resource.error} retry={resource.retry} /></>;

  const { data } = resource.data;
  const selectedTopic = data.risingTopics.find((topic) => topic.topicId === selectedTopicId) ?? null;
  const notCollected = data.collectionHealth === "NOT_COLLECTED";
  const drill = (extra: Record<string, string>) => {
    const next = new URLSearchParams(overviewFilters);
    Object.entries(extra).forEach(([key, value]) => next.set(key, value));
    navigate(`/content?${next.toString()}`);
  };
  const selectTopic = (topicId: string) => {
    const next = new URLSearchParams(appliedSearch);
    if (topicId === selectedTopicId) next.delete("topicId"); else next.set("topicId", topicId);
    setSearch(next);
  };
  const drillTrend = (bucket: string) => /^\d{4}-\d{2}-\d{2}$/.test(bucket) ? drill({ sentiments: "NEGATIVE", from: `${bucket}T00:00:00+08:00`, to: `${bucket}T23:59:59+08:00` }) : drill({ sentiments: "NEGATIVE" });

  return <>
    <FilterBar search={appliedSearch} setSearch={setSearch} draftSearch={draftSearch} setDraftSearch={setDraftSearch} showSentiment={false} showCategory deferred defaultSearch={defaultFilters} sticky />
    {resource.error ? <><ErrorNotice error={resource.error} retry={resource.retry} compact /><div className="notice notice--stale" role="status"><Icon name="info" /><strong>下方为上一次成功查询结果，尚未按当前筛选更新。</strong></div></> : null}
    {notCollected ? <EmptyState kind="not-collected" /> : <div className={`overview-grid ${resource.refreshing ? "is-refreshing" : ""}`} aria-busy={resource.refreshing}>
      {resource.refreshing ? <div className="refresh-status" role="status"><span />正在更新数据，当前结果仍可查看</div> : null}
      <Panel title="负面问题变化" caption="点击数据点查看相关内容" className="trend-panel"><div className="trend-panel__topline"><div className="legend" aria-label="图例"><span><i className="legend__risk" />负面相关量</span></div></div><TrendChart points={data.sentimentTrend} onDrill={drillTrend} /><div className="metric-ribbon"><div><span>负面内容</span><strong>{formatNumber(data.metrics.negativeCount)}</strong></div><div><span>负面占比</span><strong>{formatPercent(data.metrics.negativeRatio)}</strong></div><div><span>帖子</span><strong>{formatNumber(data.metrics.postCount)}</strong></div><div><span>评论</span><strong>{formatNumber(data.metrics.commentCount)}</strong></div></div></Panel>
      <Panel title="问题热榜" caption="点击问题联动右侧原话" className="rising-topics">{data.risingTopics.length ? <div className="topic-ranking-table"><div className="topic-ranking-head topic-ranking-grid" aria-hidden="true"><div className="topic-ranking-head__rank">排名</div><div className="topic-ranking-head__problem">问题</div><div className="topic-ranking-head__change">较上期</div><div className="topic-ranking-head__posts">影响帖子</div><div className="topic-ranking-head__comments">评论</div><div className="topic-ranking-head__arrow" /></div><ol>{[...data.risingTopics].sort((left, right) => right.evidenceCount - left.evidenceCount).slice(0, 10).map((topic, index) => <li key={topic.topicId}><button type="button" className={topic.topicId === selectedTopicId ? "is-active" : ""} aria-pressed={topic.topicId === selectedTopicId} onClick={() => selectTopic(topic.topicId)}><div className="topic-ranking-row topic-ranking-grid"><div className="topic-ranking-row__rank"><span className={`topic-rank${index < 3 ? ` topic-rank--${index + 1}` : ""}`}>{index + 1}</span></div><div className="topic-ranking-row__problem"><b>{topic.topicName}</b></div><div className="topic-ranking-row__change"><em className={topic.changeRatio === null ? "is-unavailable" : ""}>{topic.changeRatio === null ? "-" : formatPercent(topic.changeRatio)}</em></div><div className="topic-ranking-row__posts"><small className={topic.affectedPostCount === null ? "is-unavailable" : ""}>{topic.affectedPostCount === null ? "-" : formatNumber(topic.affectedPostCount)}</small></div><div className="topic-ranking-row__comments"><small className={topic.commentCount === null ? "is-unavailable" : ""}>{topic.commentCount === null ? "-" : formatNumber(topic.commentCount)}</small></div><div className="topic-ranking-row__arrow"><Icon name="arrow" /></div></div></button></li>)}</ol></div> : <EmptyState kind="analysis" />}</Panel>
      <EvidencePanel defaultItems={data.highRiskContents} topicId={selectedTopic?.topicId ?? null} topicName={selectedTopic?.topicName ?? null} filters={overviewFilters} />
      <CategoryComparison data={data} />
      <SentimentComposition data={data} />
      <Panel title="数据覆盖与质量" caption="只展示当前能够验证的信息" className="quality-panel"><DataHealth health={data.collectionHealth} lastSuccessfulAt={data.lastSuccessfulCollectionAt} /><div className="quality-facts"><div><Icon name="database" /><span>内容覆盖</span><strong>{data.metrics.postCount === null || data.metrics.commentCount === null ? "待统计" : `${formatNumber(data.metrics.postCount + data.metrics.commentCount)}条`}</strong><small>帖子与评论</small></div><div><Icon name="check" /><span>可回溯样本</span><strong>{formatNumber(data.highRiskContents.length)}条</strong><small>当前接口返回的高风险证据</small></div><div><Icon name="status" /><span>采集状态</span><strong>{enumLabel(data.collectionHealth)}</strong><small>{data.lastSuccessfulCollectionAt ? `更新于${formatDateTime(data.lastSuccessfulCollectionAt)}` : "尚无成功采集"}</small></div></div></Panel>
    </div>}
  </>;
}
