import { Navigate, Route, Routes } from 'react-router-dom';

import Layout from './components/Layout';
import ActionItemsPage from './pages/ActionItemsPage';
import AdminDepartmentsPage from './pages/AdminDepartmentsPage';
import AdminLoginPage from './pages/AdminLoginPage';
import LoginPage from './pages/LoginPage';
import MeetingDetailPage from './pages/MeetingDetailPage';
import MeetingsListPage from './pages/MeetingsListPage';
import RecordPage from './pages/RecordPage';
import ReportDetailPage from './pages/ReportDetailPage';
import ReportsListPage from './pages/ReportsListPage';
import { getStoredAdmin, getStoredDept } from './lib/auth';

function RequireDept({ children }: { children: React.ReactNode }) {
  const dept = getStoredDept();
  if (!dept) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  if (!getStoredAdmin()) return <Navigate to="/admin/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/admin/login" element={<AdminLoginPage />} />

      <Route
        element={
          <RequireDept>
            <Layout />
          </RequireDept>
        }
      >
        <Route path="/" element={<MeetingsListPage />} />
        <Route path="/meetings/:id" element={<MeetingDetailPage />} />
        <Route path="/action-items" element={<ActionItemsPage />} />
        <Route path="/record" element={<RecordPage />} />
        <Route path="/reports" element={<ReportsListPage />} />
        <Route path="/reports/:id" element={<ReportDetailPage />} />
      </Route>

      <Route
        element={
          <RequireAdmin>
            <Layout admin />
          </RequireAdmin>
        }
      >
        <Route path="/admin/departments" element={<AdminDepartmentsPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
