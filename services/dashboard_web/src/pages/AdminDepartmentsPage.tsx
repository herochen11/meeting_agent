import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Pencil, Plus, X } from 'lucide-react';

import ErrorBanner from '../components/ErrorBanner';
import LoadingSpinner from '../components/LoadingSpinner';
import { api, type Department } from '../lib/api';

type FormState = {
  name: string;
  slug: string;
  password: string;
  chat_id: string;
  sheet_id: string;
  drive_folder_id: string;
};

const EMPTY_FORM: FormState = {
  name: '',
  slug: '',
  password: '',
  chat_id: '',
  sheet_id: '',
  drive_folder_id: '',
};

function Field({
  label,
  value,
  onChange,
  type = 'text',
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-slate-600">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-blue-400 focus:outline-none"
      />
    </div>
  );
}

export default function AdminDepartmentsPage() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [editTarget, setEditTarget] = useState<Department | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, error: queryError } = useQuery<Department[]>({
    queryKey: ['admin-departments'],
    queryFn: () => api.get<Department[]>('/api/admin/departments'),
  });

  const createMut = useMutation({
    mutationFn: (payload: Partial<FormState>) => api.post('/api/admin/departments', payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-departments'] });
      setShowCreate(false);
      setForm(EMPTY_FORM);
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : '建立失敗'),
  });

  const editMut = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Partial<FormState> }) =>
      api.patch(`/api/admin/departments/${id}`, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-departments'] });
      setEditTarget(null);
      setForm(EMPTY_FORM);
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : '更新失敗'),
  });

  const pwMut = useMutation({
    mutationFn: ({ id, password }: { id: number; password: string }) =>
      api.patch(`/api/admin/departments/${id}/password`, { password }),
    onError: (err) => alert(err instanceof Error ? err.message : '重設失敗'),
    onSuccess: () => alert('密碼已重設'),
  });

  function openCreate() {
    setForm(EMPTY_FORM);
    setError(null);
    setShowCreate(true);
  }

  function openEdit(d: Department) {
    setForm({
      name: d.name,
      slug: d.slug,
      password: '',
      chat_id: d.chat_id ?? '',
      sheet_id: d.sheet_id ?? '',
      drive_folder_id: d.drive_folder_id ?? '',
    });
    setError(null);
    setEditTarget(d);
  }

  function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    createMut.mutate({
      name: form.name,
      slug: form.slug,
      password: form.password,
      chat_id: form.chat_id || undefined,
      sheet_id: form.sheet_id || undefined,
      drive_folder_id: form.drive_folder_id || undefined,
    });
  }

  function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editTarget) return;
    editMut.mutate({
      id: editTarget.id,
      patch: {
        name: form.name,
        slug: form.slug,
        chat_id: form.chat_id || undefined,
        sheet_id: form.sheet_id || undefined,
        drive_folder_id: form.drive_folder_id || undefined,
      },
    });
  }

  function handleResetPw(d: Department) {
    const pw = window.prompt(`為 ${d.name} 重設密碼，請輸入新密碼：`);
    if (pw && pw.length >= 4) pwMut.mutate({ id: d.id, password: pw });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-800">部門管理</h1>
          <p className="text-sm text-slate-500">管理部門帳號、Telegram 與 Drive 對應</p>
        </div>
        <button
          onClick={openCreate}
          className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" />
          新增部門
        </button>
      </div>

      {isLoading && <LoadingSpinner />}
      {queryError && <ErrorBanner error={queryError} />}

      {data && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">ID</th>
                <th className="px-4 py-2 font-medium">名稱</th>
                <th className="px-4 py-2 font-medium">Slug</th>
                <th className="px-4 py-2 font-medium">Chat ID</th>
                <th className="px-4 py-2 font-medium">Sheet</th>
                <th className="px-4 py-2 font-medium">Drive</th>
                <th className="px-4 py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.map((d) => (
                <tr key={d.id}>
                  <td className="px-4 py-3 text-slate-500">{d.id}</td>
                  <td className="px-4 py-3 font-medium text-slate-800">{d.name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">{d.slug}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">
                    {d.chat_id ?? '—'}
                  </td>
                  <td className="px-4 py-3 font-mono text-[10px] text-slate-500">
                    {d.sheet_id ? `${d.sheet_id.slice(0, 8)}…` : '—'}
                  </td>
                  <td className="px-4 py-3 font-mono text-[10px] text-slate-500">
                    {d.drive_folder_id ? `${d.drive_folder_id.slice(0, 8)}…` : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      <button
                        onClick={() => openEdit(d)}
                        className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-1 text-xs text-slate-700 hover:bg-slate-200"
                      >
                        <Pencil className="h-3 w-3" />
                        編輯
                      </button>
                      <button
                        onClick={() => handleResetPw(d)}
                        className="inline-flex items-center gap-1 rounded bg-amber-50 px-2 py-1 text-xs text-amber-700 hover:bg-amber-100"
                      >
                        <KeyRound className="h-3 w-3" />
                        重設密碼
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(showCreate || editTarget) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form
            onSubmit={showCreate ? submitCreate : submitEdit}
            className="w-full max-w-md space-y-3 rounded-lg bg-white p-5 shadow-lg"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-800">
                {showCreate ? '新增部門' : `編輯 ${editTarget?.name}`}
              </h2>
              <button
                type="button"
                onClick={() => {
                  setShowCreate(false);
                  setEditTarget(null);
                }}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <Field label="名稱" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
            <Field label="Slug" value={form.slug} onChange={(v) => setForm({ ...form, slug: v })} required />
            {showCreate && (
              <Field
                label="初始密碼"
                value={form.password}
                onChange={(v) => setForm({ ...form, password: v })}
                type="password"
                required
              />
            )}
            <Field
              label="Chat ID（可選）"
              value={form.chat_id}
              onChange={(v) => setForm({ ...form, chat_id: v })}
            />
            <Field
              label="Sheet ID（可選）"
              value={form.sheet_id}
              onChange={(v) => setForm({ ...form, sheet_id: v })}
            />
            <Field
              label="Drive Folder ID（可選）"
              value={form.drive_folder_id}
              onChange={(v) => setForm({ ...form, drive_folder_id: v })}
            />

            {error && <ErrorBanner error={error} />}

            <button
              type="submit"
              disabled={createMut.isPending || editMut.isPending}
              className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:bg-slate-300"
            >
              {showCreate ? '建立' : '儲存'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
