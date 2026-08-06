import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, api, type Brand } from "../api/client";
import { EmptyState, ErrorNotice, Panel, StatusBadge } from "../components/common";
import { PageHeader, SkeletonPage } from "../components/page";
import { useResource } from "../hooks/use-resource";
import { errorMessage, formatDateTime } from "../utils/format";

export function BrandsPage(): ReactNode {
  const brands = useResource(useMemo(() => () => api.getBrands(), []), []);
  const classifications = useResource(useMemo(() => () => api.getClassifications(), []), []);
  const [tab, setTab] = useState<"brands" | "classifications">("brands");
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<Brand | "new" | null>(null);
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState("");

  const openEditor = (brand: Brand | "new") => {
    setEditing(brand);
    setName(brand === "new" ? "" : brand.name);
    setAliases(brand === "new" ? "" : brand.searchTerms.filter((term) => term.type === "ALIAS").map((term) => term.value).join("，"));
  };

  const saveBrand = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing || !name.trim()) return;
    const retainedTerms = editing === "new" ? [] : editing.searchTerms.filter((term) => term.type !== "ALIAS" && term.status !== "ARCHIVED").map(({ type, value }) => ({ type, value }));
    const input = { name: name.trim(), status: editing === "new" ? "DRAFT" as const : editing.status, searchTerms: [...retainedTerms, ...aliases.split(/[，,]/).map((value) => value.trim()).filter(Boolean).map((value) => ({ type: "ALIAS" as const, value }))] };
    try {
      if (editing === "new") await api.createBrand(input); else await api.updateBrand(editing, input);
      setActionMessage(editing === "new" ? "品牌已创建为草稿。" : "品牌信息已更新。"); setEditing(null); brands.retry();
    } catch (error) { setActionMessage(error instanceof ApiError && error.code === "DUPLICATE_RESOURCE" ? "品牌名称与已有监控项重复。" : errorMessage(error)); }
  };

  const toggleBrand = async (brand: Brand) => {
    setActionMessage(null);
    try {
      await api.updateBrand(brand, { status: brand.status === "ENABLED" ? "DISABLED" : "ENABLED" });
      setActionMessage(brand.status === "ENABLED" ? "品牌已停用，历史数据继续保留。" : "品牌已启用。"); brands.retry();
    } catch (error) { setActionMessage(error instanceof ApiError && error.code === "VERSION_CONFLICT" ? "品牌信息已变化，请重新加载后再操作。" : errorMessage(error)); }
  };
  const collect = async (brand: Brand) => {
    try { const response = await api.triggerCollection(brand.id); setActionMessage(`采集任务已创建：${response.data.id}`); brands.retry(); }
    catch (error) { setActionMessage(error instanceof ApiError && error.code === "COLLECTION_ALREADY_RUNNING" ? "该品牌已有采集任务正在运行。" : errorMessage(error)); }
  };

  if (brands.loading || classifications.loading) return <><PageHeader eyebrow="监控配置" title="品牌监控" description="维护品牌范围和分类词表。" /><SkeletonPage /></>;
  return <><PageHeader eyebrow="监控配置" title="品牌监控" description="品牌停用后不再新建定时任务，历史内容仍然保留。" action={<button className="button button--primary" type="button" onClick={() => openEditor("new")}>新增品牌</button>} /><div className="segmented"><button className={tab === "brands" ? "is-active" : ""} type="button" onClick={() => setTab("brands")}>监控品牌</button><button className={tab === "classifications" ? "is-active" : ""} type="button" onClick={() => setTab("classifications")}>分类词表</button></div>{actionMessage ? <div className="notice" role="status"><p>{actionMessage}</p></div> : null}{brands.error || classifications.error ? <ErrorNotice error={brands.error ?? classifications.error} retry={() => { brands.retry(); classifications.retry(); }} compact /> : null}{tab === "brands" ? <Panel title="品牌采集台账" caption={`${brands.data?.pagination.totalItems ?? 0}个品牌`}>{brands.data?.items.length ? <div className="table-scroll"><table><thead><tr><th>品牌</th><th>状态</th><th>相关词</th><th>最后成功采集</th><th>最近任务</th><th>操作</th></tr></thead><tbody>{brands.data.items.map((brand) => <tr key={brand.id}><td><strong>{brand.name}</strong><small>版本{brand.version}</small></td><td><StatusBadge value={brand.status} /></td><td>{brand.searchTerms.filter((term) => term.status === "ENABLED").length}</td><td>{formatDateTime(brand.lastSuccessfulCollectionAt)}</td><td><StatusBadge value={brand.latestTaskStatus} /></td><td><div className="table-actions"><button className="button button--quiet" type="button" onClick={() => openEditor(brand)}>编辑</button><button className="button button--quiet" type="button" onClick={() => void toggleBrand(brand)}>{brand.status === "ENABLED" ? "停用" : "启用"}</button><button className="button button--primary" type="button" disabled={brand.status !== "ENABLED" || brand.latestTaskStatus === "RUNNING"} title={brand.status !== "ENABLED" ? "只有已启用品牌可以更新" : undefined} onClick={() => void collect(brand)}>{brand.latestTaskStatus === "RUNNING" ? "更新进行中" : "立即更新"}</button></div></td></tr>)}</tbody></table></div> : <EmptyState kind="not-collected" />}</Panel> : <Panel title="分类词表" caption="历史数据引用的分类只能停用，不能删除"><div className="table-scroll"><table><thead><tr><th>显示名称</th><th>类型</th><th>说明</th><th>状态</th><th>排序</th></tr></thead><tbody>{classifications.data?.items.map((item) => <tr key={item.id}><td>{item.displayName}</td><td>{item.classificationType}</td><td>{item.description ?? "暂无说明"}</td><td><StatusBadge value={item.isEnabled ? "ENABLED" : "DISABLED"} /></td><td>{item.sortOrder}</td></tr>)}</tbody></table></div></Panel>}{editing ? <div className="drawer-scrim" role="presentation" onMouseDown={() => setEditing(null)}><aside className="side-drawer" role="dialog" aria-modal="true" aria-labelledby="brand-editor-title" onMouseDown={(event) => event.stopPropagation()}><header><div><span>品牌配置</span><h2 id="brand-editor-title">{editing === "new" ? "新增品牌" : `编辑${editing.name}`}</h2></div><button className="button button--quiet" type="button" onClick={() => setEditing(null)} aria-label="关闭品牌编辑">关闭</button></header><form onSubmit={(event) => void saveBrand(event)}><label><span>品牌名称<span aria-label="必填">＊</span></span><input required value={name} onChange={(event) => setName(event.target.value)} /></label><label><span>品牌别名</span><textarea value={aliases} onChange={(event) => setAliases(event.target.value)} rows={4} /><small>多个别名使用逗号分隔。</small></label><div className="drawer-actions"><button className="button button--quiet" type="button" onClick={() => setEditing(null)}>取消</button><button className="button button--primary" type="submit" disabled={!name.trim()}>保存品牌</button></div></form></aside></div> : null}</>;
}
