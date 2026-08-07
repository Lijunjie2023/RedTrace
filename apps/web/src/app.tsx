import { Navigate, Route, Routes } from "react-router-dom";
import { ProtectedRoutes } from "./auth";
import { AppShell } from "./layout/app-shell";
import { BrandsPage } from "./pages/brands";
import { ContentDetailPage } from "./pages/content-detail";
import { ContentPage } from "./pages/content";
import { DataStatusPage } from "./pages/data-status";
import { DataManagementPage } from "./pages/data-management";
import { DataCollectionPage } from "./pages/data-collection";
import { InsightsPage } from "./pages/insights";
import { LoginPage } from "./pages/login";
import { OverviewPage } from "./pages/overview";

export function App() {
  return <Routes><Route path="/login" element={<LoginPage />} /><Route element={<ProtectedRoutes />}><Route element={<AppShell />}><Route path="/overview" element={<OverviewPage />} /><Route path="/insights" element={<InsightsPage />} /><Route path="/keywords" element={<InsightsPage mode="keywords" />} /><Route path="/content" element={<ContentPage />} /><Route path="/content/:contentType/:id" element={<ContentDetailPage />} /><Route path="/brands" element={<BrandsPage />} /><Route path="/data-collection" element={<DataCollectionPage />} /><Route path="/data-management" element={<DataManagementPage />} /><Route path="/data-status" element={<DataStatusPage />} /></Route></Route><Route path="/" element={<Navigate to="/overview" replace />} /><Route path="*" element={<Navigate to="/overview" replace />} /></Routes>;
}
