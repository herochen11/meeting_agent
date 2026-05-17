// ActionItemModal — 新增 / 編輯 Action Item 共用 modal。
// mode='create' 走 POST /api/action-items；mode='edit' 走 PATCH /api/action-items/:id。
// 成功後 invalidate ['action-items']，由 ActionItemsPage 重新拉資料。

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { api, ApiError, type ActionItem } from '../lib/api';

type Status = '未開始' | '進行中' | '已完成';
type Priority = '高' | '中' | '低';

const STATUSES: Status[] = ['未開始', '進行中', '已完成'];
const PRIORITIES: Priority[] = ['高', '中', '低'];

export type ActionItemModalMode =
  | { kind: 'create' }
  | { kind: 'edit'; item: ActionItem };

interface Props {
  mode: ActionItemModalMode;
  onClose: () => void;
}

interface FormState {
  description: string;
  assignee: string;
  priority: Priority;
  status: Status;
  due_date: string;
  notes: string;
}

function initialState(mode: ActionItemModalMode): FormState {
  if (mode.kind === 'edit') {
    const it = mode.item;
    return {
      description: it.description ?? '',
      assignee: it.assignee ?? '',
      priority: (it.priority ?? '中') as Priority,
      status: it.status,
      due_date: it.due_date ?? '',
      notes: it.notes ?? '',
    };
  }
  return {
    description: '',
    assignee: '',
    priority: '中',
    status: '未開始',
    due_date: '',
    notes: '',
  };
}

export default function ActionItemModal({ mode, onClose }: Props) {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(() => initialState(mode));
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // ESC 關閉
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const mutation = useMutation({
    mutationFn: async (payload: Partial<ActionItem>) => {
      if (mode.kind === 'edit') {
        return api.patch<ActionItem>(`/api/action-items/${mode.item.id}`, payload);
      }
      return api.post<ActionItem>('/api/action-items', payload);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['action-items'] });
      onClose();
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) setErrMsg(err.message);
      else if (err instanceof Error) setErrMsg(err.message);
      else setErrMsg('未知錯誤');
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrMsg(null);

    const description = form.description.trim();
    if (!description) {
      setErrMsg('任務描述為必填');
      return;
    }

    if (mode.kind === 'edit') {
      // PATCH：只送有變動的欄位；後端對 status / priority 校驗會報錯，這裡先做基本檢查
      const orig = mode.item;
      const patch: Partial<ActionItem> = {};
      if (description !== (orig.description ?? '')) patch.description = description;
      const assignee = form.assignee.trim();
      if (assignee !== (orig.assignee ?? '')) {
        patch.assignee = assignee === '' ? null : assignee;
      }
      if (form.priority !== (orig.priority ?? '中')) patch.priority = form.priority;
      if (form.status !== orig.status) patch.status = form.status;
      const due = form.due_date.trim();
      if (due !== (orig.due_date ?? '')) patch.due_date = due === '' ? null : due;
      const notes = form.notes.trim();
      if (notes !== (orig.notes ?? '')) patch.notes = notes === '' ? null : notes;

      if (Object.keys(patch).length === 0) {
        // 沒改動，直接關
        onClose();
        return;
      }
      mutation.mutate(patch);
    } else {
      // POST：必填 description，其餘可空
      const payload: Record<string, unknown> = { description };
      const assignee = form.assignee.trim();
      if (assignee) payload.assignee = assignee;
      payload.priority = form.priority;
      // status 新建 API 強制 '未開始'（後端 hardcoded），這邊不送，避免混淆
      const due = form.due_date.trim();
      if (due) payload.due_date = due;
      const notes = form.notes.trim();
      if (notes) payload.notes = notes;
      mutation.mutate(payload as Partial<ActionItem>);
    }
  }

  const title = mode.kind === 'edit' ? '編輯 Action Item' : '新增 Action Item';
  const submitLabel = mode.kind === 'edit' ? '儲存' : '建立';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-800">{title}</h2>
          {mode.kind === 'edit' && (
            <span className="font-mono text-xs text-slate-400">{mode.item.code ?? '—'}</span>
          )}
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              任務描述 <span className="text-red-500">*</span>
            </label>
            <textarea
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              rows={3}
              required
              autoFocus
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="具體任務內容（包含背景、規格、預期產出）"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">負責人</label>
              <input
                type="text"
                value={form.assignee}
                onChange={(e) => setForm((f) => ({ ...f, assignee: e.target.value }))}
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="例如 Brian"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">優先級</label>
              <select
                value={form.priority}
                onChange={(e) =>
                  setForm((f) => ({ ...f, priority: e.target.value as Priority }))
                }
                className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">
                狀態
                {mode.kind === 'create' && (
                  <span className="ml-1 text-[10px] text-slate-400">（新增固定為未開始）</span>
                )}
              </label>
              <select
                value={form.status}
                onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as Status }))}
                disabled={mode.kind === 'create'}
                className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-slate-50 disabled:text-slate-400"
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">預計完成時間</label>
              <input
                type="date"
                value={form.due_date}
                onChange={(e) => setForm((f) => ({ ...f, due_date: e.target.value }))}
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">備註</label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              rows={2}
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="補充說明（可空）"
            />
          </div>

          {errMsg && (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {errMsg}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={mutation.isPending}
              className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={mutation.isPending}
              className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {mutation.isPending ? '處理中…' : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
