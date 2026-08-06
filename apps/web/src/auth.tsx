import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { api } from "./api/client";
import { LoadingState } from "./components/common";

interface AuthContextValue {
  authenticated: boolean;
  checking: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    void api.getSession()
      .then((response) => setAuthenticated(response.data.isAuthenticated))
      .catch((error: unknown) => {
        void error;
        setAuthenticated(false);
      })
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    const clearSession = () => setAuthenticated(false);
    window.addEventListener("readtrace:auth-required", clearSession);
    return () => window.removeEventListener("readtrace:auth-required", clearSession);
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    authenticated,
    checking,
    login: async (username, password) => {
      const response = await api.login(username, password);
      setAuthenticated(response.data.isAuthenticated);
    },
    logout: async () => {
      await api.logout();
      setAuthenticated(false);
    }
  }), [authenticated, checking]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("AuthProvider缺失");
  return value;
}

export function ProtectedRoutes(): ReactNode {
  const auth = useAuth();
  const location = useLocation();
  if (auth.checking) return <main className="standalone-state"><LoadingState label="正在检查登录状态" /></main>;
  if (!auth.authenticated) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <Outlet />;
}
