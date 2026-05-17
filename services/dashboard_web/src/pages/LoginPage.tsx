import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import ErrorBanner from '../components/ErrorBanner';
import { login } from '../lib/auth';

const DEFAULT_DEPTS = [
  { slug: 'production', label: '生管部門 (production)' },
  { slug: 'test', label: '測試群 (test)' },
  { slug: 'test2', label: '測試 2 群 (test2)' },
];

export default function LoginPage() {
  const navigate = useNavigate();
  const [slug, setSlug] = useState(DEFAULT_DEPTS[0].slug);
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(slug, password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : '登入失敗');
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
          <h1 className="text-xl font-semibold text-slate-800">NoirsBoxes 會議管理</h1>
          <p className="text-sm text-slate-500">請選擇部門並輸入密碼登入</p>
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium text-slate-700">部門</label>
          <select
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
          >
            {DEFAULT_DEPTS.map((d) => (
              <option key={d.slug} value={d.slug}>
                {d.label}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium text-slate-700">密碼</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
            autoComplete="current-password"
          />
        </div>

        {error && <ErrorBanner error={error} />}

        <button
          type="submit"
          disabled={submitting || !password}
          className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {submitting ? '登入中…' : '登入'}
        </button>

        <div className="border-t border-slate-200 pt-3 text-center text-xs text-slate-500">
          <Link to="/admin/login" className="text-blue-600 hover:underline">
            Admin 登入 →
          </Link>
        </div>
      </form>
    </div>
  );
}
