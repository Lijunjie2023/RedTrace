import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useResponseMeta } from "../api/meta-store";
import { useAuth } from "../auth";
import { Icon, type IconName } from "../components/icons";
import { formatDateTime } from "../utils/format";

const navigation = [
  ["/overview", "概览", "overview"],
  ["/insights", "原因洞察", "insights"],
  ["/content", "内容库", "content"],
  ["/brands", "品牌监控", "brands"],
  ["/data-status", "数据状态", "status"]
] as const;

const pageNames: Record<string, string> = {
  overview: "舆情概览", insights: "原因洞察", content: "内容库", brands: "品牌监控", "data-status": "数据状态"
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
    <div className={`app-shell ${meta?.dataMode === "MOCK" ? "has-simulation" : ""}`}>
      <header className="topbar">
        <div className="topbar__context"><span>小红书舆情监测</span><strong>{pageName}</strong></div>
        <div className="topbar__meta"><span>数据生成于 {meta ? formatDateTime(meta.generatedAt) : "读取中"}</span><span className="mode-indicator">{meta?.dataMode === "MOCK" ? "模拟模式" : meta?.dataMode === "LIVE" ? "正式数据" : "连接中"}</span><button className="button button--quiet" type="button" onClick={() => void logout()}><Icon name="logout" />安全退出</button></div>
      </header>
      {meta?.dataMode === "MOCK" ? <div className="simulation-banner" role="status"><Icon name="warning" /><strong>当前为模拟模式</strong><span>页面数据仅用于界面验收，不代表真实舆情。</span></div> : null}
      <aside className="sidebar" aria-label="主导航">
        <NavLink className="brandmark" to="/overview"><span><b>R</b>T</span><div><strong><b>Red</b>Trace</strong><small>小红书舆情监测系统</small></div></NavLink>
        <nav>{navigation.map(([to, label, icon]) => <NavLink key={to} to={to} title={label}><Icon name={icon as IconName} /><b>{label}</b></NavLink>)}</nav>
        <div className="sidebar__note"><Icon name="database" /><div><span>数据来源</span><strong>小红书</strong><small>采集状态以数据状态页为准</small></div></div>
      </aside>
      <main className="main-content"><Outlet /></main>
    </div>
    </UnsavedChangesContext.Provider>
  );
}
