import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type Topic } from "../api/client";
import { DataModeStamp, EmptyState, ErrorNotice, FilterBar, Panel, StatusBadge } from "../components/common";
import { PageHeader, SkeletonPage } from "../components/page";
import { useResource } from "../hooks/use-resource";
import { formatNumber, formatPercent } from "../utils/format";

export function InsightsPage({ mode = "analysis" }: { mode?: "analysis" | "keywords" }): ReactNode {
  const [search, setSearch] = useSearchParams();
  const sentiment = search.get("sentiment") ?? "NEGATIVE";
  const query = useMemo(() => {
    const value = new URLSearchParams(search);
    value.set("sentiment", sentiment);
    if (!value.has("page")) value.set("page", "1");
    if (!value.has("pageSize")) value.set("pageSize", "20");
    return value;
  }, [search, sentiment]);
  const key = query.toString();
  const topics = useResource(useMemo(() => () => mode === "keywords"
    ? Promise.resolve({ items: [], pagination: { page: 1, pageSize: 20 as const, totalItems: 0, totalPages: 0 }, analysisStatus: undefined })
    : api.getTopics(new URLSearchParams(key)), [key, mode]), [key, mode]);
  const keywords = useResource(useMemo(() => () => api.getKeywords(new URLSearchParams(key)), [key]), [key]);
  const [selectedTopic, setSelectedTopic] = useState<Topic | null>(null);
  const evidence = useResource(useMemo(() => () => selectedTopic ? api.getTopicEvidence(selectedTopic.id) : Promise.resolve({ items: [], pagination: { page: 1, pageSize: 20 as const, totalItems: 0, totalPages: 0 } }), [selectedTopic]), [selectedTopic?.id]);

  useEffect(() => {
    if (mode === "keywords") {
      setSelectedTopic(null);
      return;
    }
    if (!topics.data) return;
    const topicId = search.get("topicId");
    const nextTopic = topics.data.items.find((topic) => topic.id === topicId) ?? topics.data.items[0] ?? null;
    setSelectedTopic((current) => current?.id === nextTopic?.id ? current : nextTopic);
    if (nextTopic && nextTopic.id !== topicId) {
      const next = new URLSearchParams(search);
      next.set("topicId", nextTopic.id);
      setSearch(next, { replace: true });
    }
  }, [mode, search, setSearch, topics.data]);

  const selectTopic = (topic: Topic) => {
    const next = new URLSearchParams(search);
    next.set("topicId", topic.id);
    setSelectedTopic(topic);
    setSearch(next);
  };

  const changeSentiment = (value: string) => {
    const next = new URLSearchParams(search);
    next.set("sentiment", value);
    next.delete("page");
    next.delete("topicId");
    setSelectedTopic(null);
    setSearch(next);
  };

  const pageCopy = mode === "keywords"
    ? { eyebrow: "关键词台账", title: "关键词", description: "查看关键词热度，并进入相关帖子核对原文。" }
    : { eyebrow: "问题档案", title: "问题分析", description: "从问题主题和关键词回看代表性证据。" };
  const loading = keywords.loading || (mode === "analysis" && topics.loading);
  const blockingError = keywords.error ?? (mode === "analysis" ? topics.error : null);
  if (loading) return <><PageHeader {...pageCopy} /><SkeletonPage /></>;
  if (!keywords.data || (mode === "analysis" && !topics.data)) return <><PageHeader {...pageCopy} /><ErrorNotice error={blockingError} retry={() => { if (mode === "analysis") topics.retry(); keywords.retry(); }} /></>;

  const keywordHref = (keyword: string) => {
    const next = new URLSearchParams(search);
    next.delete("topicId");
    next.delete("page");
    next.set("keyword", keyword);
    next.set("sentiments", sentiment);
    next.set("contentType", "POST");
    return `/content?${next.toString()}`;
  };
  if (mode === "keywords") {
    return (
      <>
        <PageHeader {...pageCopy} />
        <FilterBar search={search} setSearch={setSearch} showSentiment={false} />
        <div className="segmented" aria-label="关键词情感范围"><button className={sentiment === "NEGATIVE" ? "is-active" : ""} type="button" onClick={() => changeSentiment("NEGATIVE")}>负面关键词</button><button className={sentiment === "POSITIVE" ? "is-active" : ""} type="button" onClick={() => changeSentiment("POSITIVE")}>正向关键词</button></div>
        {keywords.error ? <ErrorNotice error={keywords.error} retry={keywords.retry} compact /> : null}
        <Panel title="关键词台账" caption={`${keywords.data.pagination.totalItems}个关键词`} className="keyword-table keyword-page-table">{keywords.data.items.length ? <div className="table-scroll"><table><thead><tr><th>关键词</th><th>出现</th><th>帖子</th><th>评论</th><th>用户</th><th>变化</th><th>操作</th></tr></thead><tbody>{keywords.data.items.map((keyword) => <tr key={keyword.keyword}><td>{keyword.keyword}</td><td>{keyword.occurrenceCount}</td><td>{keyword.postCount}</td><td>{keyword.commentCount}</td><td>{keyword.userCount}</td><td>{formatPercent(keyword.changeRatio)}</td><td><Link to={keywordHref(keyword.keyword)}>查看相关帖子</Link></td></tr>)}</tbody></table></div> : <EmptyState kind="analysis" />}</Panel>
      </>
    );
  }
  if (!topics.data) return null;
  const unavailable = topics.data.analysisStatus === "NOT_AVAILABLE";

  return (
    <>
      <PageHeader {...pageCopy} />
      <FilterBar search={search} setSearch={setSearch} showSentiment={false} />
      <div className="segmented" aria-label="洞察情感范围"><button className={sentiment === "NEGATIVE" ? "is-active" : ""} type="button" onClick={() => changeSentiment("NEGATIVE")}>负面原因</button><button className={sentiment === "POSITIVE" ? "is-active" : ""} type="button" onClick={() => changeSentiment("POSITIVE")}>正向卖点</button></div>
      {topics.error || keywords.error ? <ErrorNotice error={topics.error ?? keywords.error} retry={() => { topics.retry(); keywords.retry(); }} compact /> : null}
      {unavailable ? <EmptyState kind="analysis" /> : (
        <div className="insights-layout">
          <Panel title="原因主题排行" caption={`${topics.data.pagination.totalItems}个主题`} className="topic-list">
            {topics.data.items.length ? <ol>{topics.data.items.map((topic, index) => <li key={topic.id}><button className={selectedTopic?.id === topic.id ? "is-active" : ""} type="button" onClick={() => selectTopic(topic)}><span className="topic-index">{String(index + 1).padStart(2, "0")}</span><div><b>{topic.name}</b><p>{topic.description}</p><small>{formatNumber(topic.contentCount)}条内容 · {topic.evidenceCount}条证据 · {topic.changeRatio === null ? "缺少环比" : formatPercent(topic.changeRatio)}</small></div><StatusBadge value={topic.analysisOrigin} /></button></li>)}</ol> : <EmptyState kind="filtered" onClear={() => setSearch(new URLSearchParams())} />}
          </Panel>
          <Panel title="关键词台账" caption="数字按当前筛选统计" className="keyword-table"><div className="table-scroll"><table><thead><tr><th>关键词</th><th>出现</th><th>帖子</th><th>评论</th><th>用户</th><th>变化</th><th>操作</th></tr></thead><tbody>{keywords.data.items.map((keyword) => <tr key={keyword.keyword}><td>{keyword.keyword}</td><td>{keyword.occurrenceCount}</td><td>{keyword.postCount}</td><td>{keyword.commentCount}</td><td>{keyword.userCount}</td><td>{formatPercent(keyword.changeRatio)}</td><td><Link to={keywordHref(keyword.keyword)}>查看相关帖子</Link></td></tr>)}</tbody></table></div></Panel>
          <aside className="evidence-rail"><DataModeStamp /><header><span>证据侧栏</span><h2>{selectedTopic?.name ?? "选择原因主题"}</h2><p>{selectedTopic?.description ?? "从左侧选择一个主题查看证据。"}</p></header>{evidence.loading ? <p>正在读取证据…</p> : evidence.error ? <ErrorNotice error={evidence.error} retry={evidence.retry} compact /> : evidence.data?.items.length ? evidence.data.items.map((item) => <article key={`${item.contentType}-${item.contentId}`}><span>{item.contentType === "POST" ? "帖子" : "评论"}</span><p>{item.excerpt ?? "原文内容缺失"}</p><small>点赞{formatNumber(item.likedCount)}</small><Link to={`/content/${item.contentType}/${item.contentId}`}>查看完整证据</Link></article>) : <EmptyState kind="analysis" />}</aside>
        </div>
      )}
    </>
  );
}
