import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Eye, EyeOff, Loader2, Pencil, Plus } from 'lucide-react';

import ActionItemModal, { type ActionItemModalMode } from '../components/ActionItemModal';
import ErrorBanner from '../components/ErrorBanner';
import LoadingSpinner from '../components/LoadingSpinner';
import { api, type ActionItem } from '../lib/api';

type Status = '未開始' | '進行中' | '已完成';
const STATUSES: Status[] = ['未開始', '進行中', '已完成'];
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const ownerColors = [
  'bg-blue-100 text-blue-700',
  'bg-emerald-100 text-emerald-700',
  'bg-amber-100 text-amber-700',
  'bg-purple-100 text-purple-700',
  'bg-pink-100 text-pink-700',
  'bg-cyan-100 text-cyan-700',
  'bg-indigo-100 text-indigo-700',
];

function ownerChipColor(name: string | null): string {
  if (!name) return 'bg-slate-100 text-slate-600';
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return ownerColors[h % ownerColors.length];
}

function groupByOwner(items: ActionItem[]): Map<string, ActionItem[]> {
  const m = new Map<string, ActionItem[]>();
  for (const it of items) {
    const key = it.assignee ?? '未指派';
    if (!m.has(key)) m.set(key, []);
    m.get(key)!.push(it);
  }
  return m;
}

/** 已完成項目的 7 天保留判定。
 * 規則：以 due_date 為準；若 NULL 則 fallback updated_at；兩者皆 NULL 一律保留。 */
function isCompletedWithinWindow(it: ActionItem, threshold: Date): boolean {
  if (it.status !== '已完成') return true;
  const refStr = it.due_date ?? it.updated_at ?? null;
  if (!refStr) return true;
  const ref = new Date(refStr);
  if (Number.isNaN(ref.getTime())) return true;
  return ref >= threshold;
}

function StatusDropdown({
  current,
  onChange,
  disabled,
}: {
  current: Status;
  onChange: (s: Status) => void;
  disabled?: boolean;
}) {
  return (
    <div className="relative w-fit">
      <select
        value={current}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value as Status;
          if (next !== current) onChange(next);
        }}
        className={`w-fit rounded border border-slate-300 bg-white py-0.5 pl-2 pr-6 text-[11px] font-medium text-slate-700 shadow-sm transition focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 ${
          disabled ? 'cursor-not-allowed bg-slate-100 text-slate-400' : 'cursor-pointer hover:border-slate-400'
        }`}
        title="切換狀態"
      >
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      {disabled && (
        <Loader2 className="pointer-events-none absolute right-1 top-1/2 h-3 w-3 -translate-y-1/2 animate-spin text-slate-400" />
      )}
    </div>
  );
}

function StatusColumn({
  status,
  items,
  totalCount,
  onEdit,
  onStatusChange,
  pendingId,
  showAllCompleted,
  onToggleShowAll,
  hiddenCompletedCount,
}: {
  status: Status;
  items: ActionItem[];
  totalCount: number;
  onEdit: (it: ActionItem) => void;
  onStatusChange: (it: ActionItem, s: Status) => void;
  pendingId: number | null;
  showAllCompleted?: boolean;
  onToggleShowAll?: () => void;
  hiddenCompletedCount?: number;
}) {
  const grouped = useMemo(() => groupByOwner(items), [items]);
  const showCountSplit = status === '已完成' && totalCount !== items.length;
  const showToggle = status === '已完成' && onToggleShowAll;

  return (
    <div className="flex flex-col rounded-lg border border-slate-200 bg-slate-50">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 text-sm font-medium text-slate-700">
        <div>
          {status}
          <span className="ml-2 rounded bg-white px-2 py-0.5 text-xs text-slate-500">
            {showCountSplit ? `${items.length} / ${totalCount}` : items.length}
          </span>
        </div>
        {showToggle && (
          <button
            onClick={onToggleShowAll}
            title={
              showAllCompleted
                ? '收起：只顯示近 7 天的已完成'
                : (hiddenCompletedCount ?? 0) > 0
                  ? `已隱藏 ${hiddenCompletedCount} 個（超過 7 天）`
                  : '目前沒有超過 7 天的已完成項目'
            }
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition ${
              showAllCompleted
                ? 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                : 'bg-white text-slate-500 hover:bg-slate-100'
            }`}
          >
            {showAllCompleted ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            {showAllCompleted
              ? '收起'
              : (hiddenCompletedCount ?? 0) > 0
                ? `顯示全部 (+${hiddenCompletedCount})`
                : '顯示全部'}
          </button>
        )}
      </div>

      <div className="flex-1 space-y-3 p-3">
        {[...grouped.entries()].map(([owner, ownerItems]) => (
          <div key={owner} className="space-y-2">
            <div
              className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${ownerChipColor(owner)}`}
            >
              {owner}
              <span className="ml-1 opacity-70">({ownerItems.length})</span>
            </div>
            {ownerItems.map((it) => (
              <div
                key={it.id}
                className="space-y-1.5 rounded-md border border-slate-200 bg-white p-2 shadow-sm"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="font-mono text-[10px] text-slate-400">{it.code ?? '—'}</span>
                  <button
                    onClick={() => onEdit(it)}
                    title="編輯（描述、負責人、優先級、截止日、備註）"
                    className="text-slate-400 hover:text-slate-700"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                </div>
                <div
                  className={`text-xs ${it.status === '已完成' ? 'text-slate-400 line-through' : 'text-slate-700'}`}
                >
                  {it.description}
                </div>
                <div className="flex justify-between text-[11px] text-slate-400">
                  <span>優先：{it.priority ?? '—'}</span>
                  <span>截止：{it.due_date ?? '—'}</span>
                </div>
                <div className="flex justify-end pt-0.5">
                  <StatusDropdown
                    current={it.status as Status}
                    onChange={(s) => onStatusChange(it, s)}
                    disabled={pendingId === it.id}
                  />
                </div>
              </div>
            ))}
          </div>
        ))}
        {items.length === 0 && (
          <div className="py-6 text-center text-xs text-slate-400">無項目</div>
        )}
      </div>
    </div>
  );
}

export default function ActionItemsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery<ActionItem[]>({
    queryKey: ['action-items'],
    queryFn: () => api.get<ActionItem[]>('/api/action-items'),
  });

  const [modal, setModal] = useState<ActionItemModalMode | null>(null);
  const [showAllCompleted, setShowAllCompleted] = useState(false);

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: Status }) =>
      api.patch<ActionItem>(`/api/action-items/${id}`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['action-items'] });
    },
  });

  function handleEdit(it: ActionItem) {
    setModal({ kind: 'edit', item: it });
  }

  function handleCreate() {
    setModal({ kind: 'create' });
  }

  function handleStatusChange(it: ActionItem, status: Status) {
    if (it.status === status) return;
    statusMutation.mutate({ id: it.id, status });
  }

  // 完整分組（未經 7 天 filter）
  const byStatusAll = useMemo(() => {
    const m: Record<Status, ActionItem[]> = { 未開始: [], 進行中: [], 已完成: [] };
    if (data) {
      for (const it of data) {
        if (m[it.status as Status]) m[it.status as Status].push(it);
      }
    }
    return m;
  }, [data]);

  // 套用 7 天 filter 後的分組（用於畫面顯示）
  const byStatus = useMemo(() => {
    const threshold = new Date(Date.now() - SEVEN_DAYS_MS);
    const result: Record<Status, ActionItem[]> = {
      未開始: byStatusAll.未開始,
      進行中: byStatusAll.進行中,
      已完成: showAllCompleted
        ? byStatusAll.已完成
        : byStatusAll.已完成.filter((it) => isCompletedWithinWindow(it, threshold)),
    };
    return result;
  }, [byStatusAll, showAllCompleted]);

  const hiddenCompletedCount =
    byStatusAll.已完成.length - byStatus.已完成.length;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-800">Action Items</h1>
          <p className="text-sm text-slate-500">
            按狀態分三欄，欄內依負責人 group。卡片底部 dropdown 切換狀態，點 ✎ 編輯其他欄位。已完成超過 7 天的項目預設隱藏，可在「已完成」欄展開。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="/api/action-items/export.xlsx"
            title="下載目前部門未完成 Action Items（Excel）"
            className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
          >
            <Download className="h-4 w-4" />
            下載 Excel
          </a>
          <button
            onClick={handleCreate}
            className="hidden items-center gap-1.5 rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 md:inline-flex"
          >
            <Plus className="h-4 w-4" />
            新增 Action Item
          </button>
        </div>
      </div>

      {isLoading && <LoadingSpinner />}
      {error && <ErrorBanner error={error} />}

      {statusMutation.isError && (
        <ErrorBanner error={statusMutation.error as Error} />
      )}

      {data && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {STATUSES.map((s) => (
            <StatusColumn
              key={s}
              status={s}
              items={byStatus[s]}
              totalCount={byStatusAll[s].length}
              onEdit={handleEdit}
              onStatusChange={handleStatusChange}
              pendingId={statusMutation.isPending ? statusMutation.variables?.id ?? null : null}
              showAllCompleted={s === '已完成' ? showAllCompleted : undefined}
              onToggleShowAll={s === '已完成' ? () => setShowAllCompleted((v) => !v) : undefined}
              hiddenCompletedCount={s === '已完成' ? hiddenCompletedCount : undefined}
            />
          ))}
        </div>
      )}

      {/* 浮動「+」按鈕（手機 / 任何視窗都看得到） */}
      <button
        onClick={handleCreate}
        title="新增 Action Item"
        className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg hover:bg-blue-700 md:hidden"
        aria-label="新增 Action Item"
      >
        <Plus className="h-6 w-6" />
      </button>

      {modal && <ActionItemModal mode={modal} onClose={() => setModal(null)} />}
    </div>
  );
}
