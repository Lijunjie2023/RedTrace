import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useResponseMeta } from "../api/meta-store";
import { useAuth } from "../auth";

const navigation = [
  ["/overview", "概览", "01"],
  ["/insights", "原因洞察", "02"],
  ["/content", "内容库", "03"],
  ["/brands", "品牌监控", "04"],
  ["/data-status", "数据状态", "05"]
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
        <NavLink className="brandmark" to="/overview"><span>RT</span><strong>ReadTrace</strong></NavLink>
        <div className="topbar__meta"><span>数据模式：{meta?.dataMode === "MOCK" ? "模拟" : meta?.dataMode === "LIVE" ? "正式" : "读取中"}</span><button className="button button--quiet" type="button" onClick={() => void logout()}>安全退出</button></div>
      </header>
      {meta?.dataMode === "MOCK" ? <div className="simulation-banner" role="status"><span aria-hidden="true">⚗</span><strong>当前为模拟模式</strong><span>页面数据仅用于界面验收，不代表真实舆情。</span></div> : null}
      <aside className="sidebar" aria-label="主导航">
        <nav>{navigation.map(([to, label, index]) => <NavLink key={to} to={to}><span>{index}</span><b>{label}</b></NavLink>)}</nav>
        <div className="sidebar__note"><span>数据来源</span><strong>小红书</strong><small>最后状态以页面提示为准</small></div>
      </aside>
      <main className="main-content"><Outlet /></main>
    </div>
    </UnsavedChangesContext.Provider>
  );
}
