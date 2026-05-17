import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import ErrorBanner from '../components/ErrorBanner';
import { adminLogin } from '../lib/auth';

export default function AdminLoginPage() {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await adminLogin(password);
      navigate('/admin/departments', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Admin 登入失敗');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <div>
          <h1 className="text-xl font-semibold text-slate-800">Admin 登入</h1>
          <p className="text-sm text-slate-500">輸入 admin 密碼以管理部門</p>
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium text-slate-700">Admin 密碼</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none"
            autoComplete="current-password"
          />
        </div>

        {error && <ErrorBanner error={error} />}

        <button
          type="submit"
          disabled={submitting || !password}
          className="w-full rounded-md bg-amber-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {submitting ? '登入中…' : '進入 Admin'}
        </button>

        <div className="border-t border-slate-200 pt-3 text-center text-xs text-slate-500">
          <Link to="/login" className="text-blue-600 hover:underline">
            ← 回部門登入
          </Link>
        </div>
      </form>
    </div>
  );
}
