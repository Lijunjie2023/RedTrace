import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useResponseMeta } from "../api/meta-store";
import { useAuth } from "../auth";
import { Icon, type IconName } from "../components/icons";
import { formatDateTime } from "../utils/format";

const navigation = [
  ["/overview", "舆情概览", "overview"],
  ["/content", "内容明细", "content"],
  ["/keywords", "关键词", "keywords"],
  ["/data-management", "数据管理", "database"],
  ["/brands", "监控设置", "settings"]
] as const;

const pageNames: Record<string, string> = {
  overview: "舆情概览", insights: "问题分析", keywords: "关键词", content: "内容明细", brands: "监控设置", "data-management": "数据管理", "data-status": "数据状态"
};

interface UnsavedChangesContextValue {
  hasUnsavedChanges: boolean;
  setHasUnsavedChanges: (value: boolean) => void;
  confirmNavigation: () => boolean;
}

const UnsavedChangesContext = createContext<UnsavedChangesContextValue | null>(null);

export function useUnsavedChanges(): UnsavedChangesContextValue {
  const value = useContext(UnsavedChangesContext);
  if (!value) throw new Error("UnsavedChangesContext缺失");
  return value;
}

export function AppShell(): ReactNode {
  const meta = useResponseMeta();
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const section = location.pathname.split("/")[1] || "overview";
  const pageName = pageNames[section] ?? "内容详情";
  const isOverview = section === "overview";

  useEffect(() => {
    document.title = `${meta?.dataMode === "MOCK" ? "[模拟] " : ""}ReadTrace｜${pageName}`;
  }, [meta?.dataMode, pageName]);

  const confirmNavigation = useCallback(() => !hasUnsavedChanges || window.confirm("还有未保存的修正，确认离开吗？"), [hasUnsavedChanges]);
  const guardValue = useMemo(() => ({ hasUnsavedChanges, setHasUnsavedChanges, confirmNavigation }), [hasUnsavedChanges, confirmNavigation]);

  const logout = async () => {
    if (!confirmNavigation()) return;
    await auth.logout();
    navigate("/login", { replace: true });
  };

  return (
    <UnsavedChangesContext.Provider value={guardValue}>
    <div className={`app-shell ${isOverview ? "is-overview" : ""} ${meta?.dataMode === "MOCK" ? "has-simulation" : ""}`}>
      <header className="topbar">
        <div className="topbar__context"><span>小红书舆情监测</span><strong>{pageName}</strong></div>
        <div className="topbar__meta"><span>数据生成于 {meta ? formatDateTime(meta.generatedAt) : "读取中"}</span><span className="mode-indicator">{meta?.dataMode === "MOCK" ? "模拟模式" : meta?.dataMode === "LIVE" ? "正式数据" : "连接中"}</span><NavLink className="topbar__status-link" to="/data-status" aria-label="查看数据状态"><Icon name="status" /></NavLink><button className="button button--quiet" type="button" onClick={() => void logout()}><Icon name="logout" />安全退出</button></div>
      </header>
      {meta?.dataMode === "MOCK" ? <div className="simulation-banner" role="status"><Icon name="warning" /><strong>当前为模拟模式</strong><span>页面数据仅用于界面验收，不代表真实舆情。</span></div> : null}
      <aside className="sidebar" aria-label="主导航">
        <NavLink className="brandmark" to="/overview"><div><strong><b>Red</b>Trace</strong><small>小红书舆情监测系统</small></div></NavLink>
        <nav>{navigation.map(([to, label, icon]) => <NavLink key={to} to={to} title={label}><Icon name={icon as IconName} /><b>{label}</b></NavLink>)}</nav>
        {isOverview ? <div className="sidebar__overview-meta"><span className="sidebar__mode" role="status" aria-label={meta?.dataMode === "MOCK" ? "模拟数据" : meta?.dataMode === "LIVE" ? "正式数据" : "连接中"} title={meta?.dataMode === "MOCK" ? "模拟数据" : meta?.dataMode === "LIVE" ? "正式数据" : "连接中"}><i aria-hidden="true" /><b>{meta?.dataMode === "MOCK" ? "模拟数据" : meta?.dataMode === "LIVE" ? "正式数据" : "连接中"}</b></span><NavLink to="/data-status" title="数据状态"><Icon name="status" /><b>数据状态</b></NavLink><button type="button" title="安全退出" onClick={() => void logout()}><Icon name="logout" /><b>安全退出</b></button></div> : <NavLink className="sidebar__note" to="/data-status"><Icon name="database" /><div><span>数据来源</span><strong>小红书</strong><small>查看采集状态与任务记录</small></div></NavLink>}
      </aside>
      <main className="main-content"><Outlet /></main>
    </div>
    </UnsavedChangesContext.Provider>
  );
}
