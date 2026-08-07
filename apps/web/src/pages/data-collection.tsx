import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  ApiError,
  api,
  type CollectionTaskSummary,
  type CredentialKind,
  type ServiceCredentialSummary
} from "../api/client";
import { ErrorNotice, Panel } from "../components/common";
import { PageHeader, SkeletonPage } from "../components/page";
import { useResource } from "../hooks/use-resource";
import { errorMessage, formatDateTime, formatNumber } from "../utils/format";

const ACTIVE_STATUSES = new Set(["QUEUED", "RUNNING", "STOPPING"]);

const credentialCopy: Record<CredentialKind, { title: string; caption: string; placeholder: string }> = {
  JUSTONEAPI: {
    title: "API采集凭证",
    caption: "用于调用JustOneAPI获取小红书帖子和评论。",
    placeholder: "输入JustOneAPI Token"
  },
  DEEPSEEK: {
    title: "AI分析凭证",
    caption: "用于采集完成后的内容分类，不影响数据入库。",
    placeholder: "输入DeepSeek API Key"
  }
};

const statusLabels: Record<string, string> = {
  QUEUED: "等待执行",
  RUNNING: "正在采集",
  STOPPING: "停止中",
  STOPPED: "已停止",
  SUCCESS: "采集完成",
  PARTIAL_SUCCESS: "部分完成",
  FAILED: "采集失败"
};

const progressItems = [
  ["fetchedPostCount", "获取帖子"],
  ["fetchedCommentCount", "获取评论"],
  ["storedPostCount", "入库帖子"],
  ["storedCommentCount", "入库评论"],
  ["skippedNoCommentPostCount", "无评论跳过"],
  ["failedCount", "失败数量"]
] as const;

type NoticeMessage = { tone: "success" | "error" | "warning"; text: string };

function credentialStatus(summary: ServiceCredentialSummary | undefined): string {
  if (!summary?.configured) return "未配置";
  return summary.lastFour ? `已配置，末尾${summary.lastFour}` : "已配置";
}

function actionError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.code === "COLLECTION_ALREADY_RUNNING") return "这个品牌已有采集任务正在运行。";
    if (error.code === "VALIDATION_ERROR") return "提交内容不符合要求，请检查后重试。";
    if (error.code === "DEPENDENCY_UNAVAILABLE") return "凭证服务暂时不可用，请联系维护人员检查服务端配置。";
  }
  return error instanceof Error ? errorMessage(error) : fallback;
}

function CredentialCard({
  kind,
  summary,
  secret,
  busy,
  onSecretChange,
  onSave,
  onDelete
}: {
  kind: CredentialKind;
  summary: ServiceCredentialSummary | undefined;
  secret: string;
  busy: boolean;
  onSecretChange: (value: string) => void;
  onSave: () => void;
  onDelete: () => void;
}): ReactNode {
  const copy = credentialCopy[kind];
  return <section className="credential-card">
    <header><div><h3>{copy.title}</h3><p>{copy.caption}</p></div><span className={summary?.configured ? "is-configured" : ""}>{credentialStatus(summary)}</span></header>
    <label>
      <span>{summary?.configured ? "更新凭证" : "填写凭证"}</span>
      <input
        type="password"
        value={secret}
        placeholder={summary?.configured ? "输入新凭证即可更新" : copy.placeholder}
        autoComplete="new-password"
        spellCheck={false}
        onChange={(event) => onSecretChange(event.target.value)}
      />
      <small>系统不会在页面回显已经保存的完整凭证。</small>
    </label>
    <div className="credential-card__actions">
      <button className="button button--primary" type="button" disabled={busy || !secret.trim()} onClick={onSave}>{busy ? "正在处理" : summary?.configured ? "更新凭证" : "保存凭证"}</button>
      <button className="button button--quiet" type="button" disabled={busy || !summary?.configured} onClick={onDelete}>删除凭证</button>
    </div>
    {summary?.updatedAt ? <small>最近更新：{formatDateTime(summary.updatedAt)}</small> : null}
  </section>;
}

function TaskProgress({ task, brandName, onStop, stopping }: {
  task: CollectionTaskSummary;
  brandName: string;
  onStop: () => void;
  stopping: boolean;
}): ReactNode {
  const active = ACTIVE_STATUSES.has(task.status);
  return <article className="collection-task">
    <header>
      <div><strong>{brandName}</strong><span>{task.keyword ? `关键词：${task.keyword}${task.noteLimit ? ` · 上限${task.noteLimit}篇` : ""}` : "历史采集任务"}</span><small>任务编号：{task.id}</small></div>
      <div className="collection-task__state"><span className={`collection-status is-${task.status.toLowerCase()}`}>{statusLabels[task.status] ?? task.status}</span><small>{task.startedAt ? formatDateTime(task.startedAt) : "等待开始"}</small></div>
    </header>
    <dl className="collection-progress">
      {progressItems.map(([field, label]) => <div key={field}><dt>{label}</dt><dd>{formatNumber(task[field])}</dd></div>)}
    </dl>
    <footer>
      <span>{task.errorSummary ?? (active ? "采集进度会自动更新" : task.finishedAt ? `结束于${formatDateTime(task.finishedAt)}` : "任务记录已经保存")}</span>
      {active ? <button className="button button--quiet" type="button" disabled={task.status === "STOPPING" || stopping} onClick={onStop}>{task.status === "STOPPING" || stopping ? "正在停止" : "停止采集"}</button> : null}
    </footer>
  </article>;
}

export function DataCollectionPage(): ReactNode {
  const taskSearch = useMemo(() => new URLSearchParams("page=1&pageSize=20&sortOrder=DESC"), []);
  const credentials = useResource(useMemo(() => () => api.getServiceCredentials(), []), []);
  const brands = useResource(useMemo(() => () => api.getBrands(), []), []);
  const tasks = useResource(useMemo(() => () => api.getTasks(taskSearch), [taskSearch]), []);
  const [secrets, setSecrets] = useState<Record<CredentialKind, string>>({ JUSTONEAPI: "", DEEPSEEK: "" });
  const [credentialBusy, setCredentialBusy] = useState<CredentialKind | null>(null);
  const [brandId, setBrandId] = useState("");
  const [keyword, setKeyword] = useState("");
  const [noteLimit, setNoteLimit] = useState(3);
  const [creating, setCreating] = useState(false);
  const [stoppingTaskId, setStoppingTaskId] = useState<string | null>(null);
  const [message, setMessage] = useState<NoticeMessage | null>(null);

  const enabledBrands = brands.data?.items.filter((brand) => brand.status === "ENABLED") ?? [];
  const credentialList = credentials.data?.data ?? [];
  const credentialMap = new Map(credentialList.map((item) => [item.kind, item]));
  const collectionCredential = credentialMap.get("JUSTONEAPI");
  const analysisCredential = credentialMap.get("DEEPSEEK");
  const taskItems = tasks.data?.items ?? [];
  const hasActiveTask = taskItems.some((task) => ACTIVE_STATUSES.has(task.status));
  const brandNames = new Map((brands.data?.items ?? []).map((brand) => [brand.id, brand.name]));

  useEffect(() => {
    if (!brandId && enabledBrands[0]) setBrandId(enabledBrands[0].id);
  }, [brandId, enabledBrands]);

  useEffect(() => {
    if (!hasActiveTask) return undefined;
    const timer = window.setInterval(tasks.retry, 3000);
    return () => window.clearInterval(timer);
  }, [hasActiveTask, tasks.retry]);

  async function saveCredential(kind: CredentialKind): Promise<void> {
    const secret = secrets[kind];
    if (!secret.trim()) return;
    setCredentialBusy(kind);
    setMessage(null);
    try {
      await api.saveServiceCredential(kind, secret);
      setSecrets((current) => ({ ...current, [kind]: "" }));
      setMessage({ tone: "success", text: `${credentialCopy[kind].title}已经保存。` });
      credentials.retry();
    } catch (error) {
      setMessage({ tone: "error", text: actionError(error, "凭证保存失败，请稍后重试。") });
    } finally {
      setCredentialBusy(null);
    }
  }

  async function deleteCredential(kind: CredentialKind): Promise<void> {
    if (!window.confirm(`确认删除${credentialCopy[kind].title}吗？删除后，相关自动任务将无法继续。`)) return;
    setCredentialBusy(kind);
    setMessage(null);
    try {
      await api.deleteServiceCredential(kind);
      setSecrets((current) => ({ ...current, [kind]: "" }));
      setMessage({ tone: "success", text: `${credentialCopy[kind].title}已经删除。` });
      credentials.retry();
    } catch (error) {
      setMessage({ tone: "error", text: actionError(error, "凭证删除失败，请稍后重试。") });
    } finally {
      setCredentialBusy(null);
    }
  }

  async function startCollection(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!brandId || !keyword.trim() || noteLimit < 1 || noteLimit > 10) return;
    setCreating(true);
    setMessage(null);
    try {
      await api.startCollection({ brandId, keyword: keyword.trim(), noteLimit });
      setMessage({ tone: "success", text: analysisCredential?.configured ? "采集任务已经创建，进度将在下方自动更新。" : "采集任务已经创建。当前未配置AI分析凭证，入库内容将等待后续分析。" });
      tasks.retry();
    } catch (error) {
      setMessage({ tone: "error", text: actionError(error, "采集任务创建失败，请稍后重试。") });
    } finally {
      setCreating(false);
    }
  }

  async function stopCollection(taskId: string): Promise<void> {
    setStoppingTaskId(taskId);
    setMessage(null);
    try {
      await api.stopCollection(taskId);
      setMessage({ tone: "warning", text: "停止请求已经提交。当前API请求完成后，任务将不再继续采集。" });
      tasks.retry();
    } catch (error) {
      setMessage({ tone: "error", text: actionError(error, "停止请求提交失败，请稍后重试。") });
    } finally {
      setStoppingTaskId(null);
    }
  }

  const header = <PageHeader eyebrow="小红书API采集" title="数据采集" description="配置服务凭证，按品牌发起采集，并查看帖子和评论的入库进度。" />;
  if ((credentials.loading && !credentials.data) || (brands.loading && !brands.data) || (tasks.loading && !tasks.data)) return <>{header}<SkeletonPage /></>;
  const loadError = credentials.error ?? brands.error ?? tasks.error;
  if ((!credentials.data || !brands.data || !tasks.data) && loadError) return <>{header}<ErrorNotice error={loadError} retry={() => { credentials.retry(); brands.retry(); tasks.retry(); }} /></>;

  return <>{header}
    {message ? <div className={`notice notice--${message.tone}`} role={message.tone === "error" ? "alert" : "status"}><p>{message.text}</p></div> : null}
    {loadError ? <ErrorNotice error={loadError} retry={() => { credentials.retry(); brands.retry(); tasks.retry(); }} compact /> : null}
    <div className="collection-console-grid">
      <Panel title="凭证设置" caption="完整凭证只在保存时提交，页面不会读取原值。" className="collection-credentials">
        <div className="credential-grid">
          {(["JUSTONEAPI", "DEEPSEEK"] as const).map((kind) => <CredentialCard
            key={kind}
            kind={kind}
            summary={credentialMap.get(kind)}
            secret={secrets[kind]}
            busy={credentialBusy === kind}
            onSecretChange={(value) => setSecrets((current) => ({ ...current, [kind]: value }))}
            onSave={() => void saveCredential(kind)}
            onDelete={() => void deleteCredential(kind)}
          />)}
        </div>
      </Panel>
      <Panel title="开始采集" caption="没有取得评论的帖子不会写入业务数据库。" className="collection-create">
        {!analysisCredential?.configured ? <div className="collection-inline-warning" role="status">当前未配置AI分析凭证。采集可以正常进行，入库内容会等待分析。</div> : null}
        <form className="collection-form" onSubmit={(event) => void startCollection(event)}>
          <label><span>品牌</span><select required value={brandId} onChange={(event) => setBrandId(event.target.value)}><option value="">请选择已启用品牌</option>{enabledBrands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}</select></label>
          <label><span>关键词</span><input required minLength={1} maxLength={50} value={keyword} placeholder="例如：卡萨帝" onChange={(event) => setKeyword(event.target.value)} /></label>
          <label><span>帖子上限</span><input required type="number" min={1} max={10} step={1} value={noteLimit} onChange={(event) => setNoteLimit(Number(event.target.value))} /><small>每次最多采集10篇帖子。</small></label>
          <button className="button button--primary" type="submit" disabled={creating || !collectionCredential?.configured || !brandId || !keyword.trim() || noteLimit < 1 || noteLimit > 10}>{creating ? "正在创建任务" : "开始采集"}</button>
        </form>
        {!collectionCredential?.configured ? <p className="collection-form__hint">请先保存API采集凭证，再开始采集。</p> : enabledBrands.length === 0 ? <p className="collection-form__hint">当前没有已启用品牌，请先在监控设置中启用品牌。</p> : null}
      </Panel>
      <Panel title="最近采集任务" caption={hasActiveTask ? "活跃任务每3秒更新一次" : `共${formatNumber(tasks.data?.pagination.totalItems ?? 0)}条任务记录`} className="collection-tasks">
        {taskItems.length ? <div className="collection-task-list">{taskItems.map((task) => <TaskProgress key={task.id} task={task} brandName={brandNames.get(task.brandId) ?? task.brandId} stopping={stoppingTaskId === task.id} onStop={() => void stopCollection(task.id)} />)}</div> : <div className="collection-empty"><strong>还没有采集任务</strong><p>配置API采集凭证并创建任务后，进度会显示在这里。</p></div>}
      </Panel>
    </div>
  </>;
}
