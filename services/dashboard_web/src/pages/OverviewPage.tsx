import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  Eye,
  EyeOff,
  Loader2,
  Pencil,
} from 'lucide-react';

import ActionItemModal, {
  type ActionItemModalMode,
} from '../components/ActionItemModal';
import ErrorBanner from '../components/ErrorBanner';
import LoadingSpinner from '../components/LoadingSpinner';
import { getStoredDept } from '../lib/auth';
import { api, type ActionItem, type MeetingListItem } from '../lib/api';

type Status = '未開始' | '進行中' | '已完成';
const STATUSES: Status[] = ['未開始', '進行中', '已完成'];
const MAX_COMPLETED_DEFAULT = 10;

// ---------- Date helpers ----------------------------------------------------

/** 取得「今天 00:00（本地時區）」的 Date — 用來判定逾期。 */
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** 把 YYYY-MM-DD 解析為當日 00:00（本地時區）。其他格式回傳 null。 */
function parseDueDate(s: string | null): Date | null {
  if (!s) return null;
  // 支援 'YYYY-MM-DD' 與 ISO datetime — 兩者都當本地日。
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

/** due_date 是否落在「明天」。 */
function isDueTomorrow(due: string | null): boolean {
  const dueDate = parseDueDate(due);
  if (!dueDate) return false;
  const tomorrow = startOfToday();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return dueDate.getTime() === tomorrow.getTime();
}

// ---------- Real-data hooks --------------------------------------------------

function useRecentMeetings() {
  return useQuery<MeetingListItem[]>({
    queryKey: ['overview', 'recent-meetings'],
    queryFn: () => api.get<MeetingListItem[]>('/api/meetings'),
    refetchInterval: 30_000,
  });
}

function useOverviewActionItems() {
  return useQuery<ActionItem[]>({
    queryKey: ['overview', 'action-items'],
    queryFn: () => api.get<ActionItem[]>('/api/action-items'),
    refetchInterval: 30_000,
  });
}

// ---------- UI helpers -------------------------------------------------------

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const isoUtc =
    iso.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + 'Z';
  const d = new Date(isoUtc);
  return d.toLocaleString('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function statusBadge(status: string) {
  if (status === '會議進行中') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs bg-emerald-50 text-emerald-700">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
        {status}
      </span>
    );
  }
  if (status === '逐字稿處理中') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs bg-amber-50 text-amber-700">
        <svg
          className="h-3 w-3 animate-spin"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
        >
          <circle cx="12" cy="12" r="9" strokeOpacity="0.25" />
          <path d="M21 12a9 9 0 0 0-9-9" strokeLinecap="round" />
        </svg>
        {status}
      </span>
    );
  }
  const map: Record<string, string> = {
    completed: 'bg-blue-50 text-blue-700',
    active: 'bg-blue-50 text-blue-700',
    failed: 'bg-red-50 text-red-700',
  };
  const cls = map[status] ?? 'bg-slate-100 text-slate-600';
  return <span className={`rounded px-2 py-0.5 text-xs ${cls}`}>{status}</span>;
}

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

function completedSortKey(it: ActionItem): number {
  const refStr = it.updated_at ?? it.due_date ?? null;
  if (!refStr) return 0;
  const t = new Date(refStr).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** 把 MeetingListItem (含 summary?: string|null) 轉成卡片所需的預覽資料。 */
function makePreview(summary: string | null): string {
  if (!summary) return '尚無摘要';
  // summary 是 markdown，第一段（第一個 \n\n 之前）拿來顯示即可
  const firstBlock = summary.split(/\n\n/)[0] ?? summary;
  // 移除 markdown heading / list 標記，純文字感覺更乾淨
  return firstBlock
    .replace(/^#+\s*/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .trim();
}

// ---------- Status dropdown (same as ActionItemsPage) -----------------------

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
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          const next = e.target.value as Status;
          if (next !== current) onChange(next);
        }}
        className={`w-fit rounded border border-slate-300 bg-white py-0.5 pl-2 pr-6 text-[11px] font-medium text-slate-700 shadow-sm transition focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 ${
          disabled
            ? 'cursor-not-allowed bg-slate-100 text-slate-400'
            : 'cursor-pointer hover:border-slate-400'
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

// ---------- Sub-components ---------------------------------------------------

function ReminderCards({
  items,
  onEdit,
}: {
  items: ActionItem[] | undefined;
  onEdit: (it: ActionItem) => void;
}) {
  const [openCard, setOpenCard] = useState<'overdue' | 'dueSoon' | null>(null);

  // 從 items 計算逾期 / 即將到期清單
  const { overdueItems, dueSoonItems } = useMemo(() => {
    if (!items) return { overdueItems: [] as ActionItem[], dueSoonItems: [] as ActionItem[] };
    const today = startOfToday();
    const od: ActionItem[] = [];
    const ds: ActionItem[] = [];
    for (const it of items) {
      if (it.status === '已完成') continue;
      const due = parseDueDate(it.due_date);
      if (!due) continue;
      if (due.getTime() < today.getTime()) {
        od.push(it);
      } else if (isDueTomorrow(it.due_date)) {
        ds.push(it);
      }
    }
    od.sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''));
    ds.sort((a, b) => (a.code ?? '').localeCompare(b.code ?? ''));
    return { overdueItems: od, dueSoonItems: ds };
  }, [items]);

  const overdue = overdueItems.length;
  const dueSoon = dueSoonItems.length;

  function toggle(card: 'overdue' | 'dueSoon') {
    setOpenCard((cur) => (cur === card ? null : card));
  }

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-slate-800">跟催警示</h2>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <button
          onClick={() => overdue > 0 && toggle('overdue')}
          disabled={overdue === 0}
          className={`rounded-lg border p-4 text-left shadow-sm transition ${
            overdue === 0
              ? 'cursor-default border-slate-200 bg-white opacity-60'
              : 'border-red-200 bg-red-50 hover:bg-red-100 hover:shadow-md'
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <AlertTriangle
                className={`h-5 w-5 ${overdue === 0 ? 'text-slate-400' : 'text-red-700'}`}
              />
              <span
                className={`text-sm font-medium ${
                  overdue === 0 ? 'text-slate-500' : 'text-red-700'
                }`}
              >
                已逾期
              </span>
            </div>
            {overdue > 0 &&
              (openCard === 'overdue' ? (
                <ChevronDown className="h-4 w-4 text-red-600" />
              ) : (
                <ChevronRight className="h-4 w-4 text-red-600" />
              ))}
          </div>
          <div
            className={`mt-2 text-3xl font-semibold ${
              overdue === 0 ? 'text-slate-400' : 'text-red-700'
            }`}
          >
            {overdue}
          </div>
          <div
            className={`mt-1 text-xs ${
              overdue === 0 ? 'text-slate-400' : 'text-red-600'
            }`}
          >
            {overdue === 0 ? '目前沒有逾期項目' : '個 Action Items'}
          </div>
        </button>

        <button
          onClick={() => dueSoon > 0 && toggle('dueSoon')}
          disabled={dueSoon === 0}
          className={`rounded-lg border p-4 text-left shadow-sm transition ${
            dueSoon === 0
              ? 'cursor-default border-slate-200 bg-white opacity-60'
              : 'border-amber-200 bg-amber-50 hover:bg-amber-100 hover:shadow-md'
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Clock
                className={`h-5 w-5 ${dueSoon === 0 ? 'text-slate-400' : 'text-amber-700'}`}
              />
              <span
                className={`text-sm font-medium ${
                  dueSoon === 0 ? 'text-slate-500' : 'text-amber-700'
                }`}
              >
                即將到期
              </span>
            </div>
            {dueSoon > 0 &&
              (openCard === 'dueSoon' ? (
                <ChevronDown className="h-4 w-4 text-amber-600" />
              ) : (
                <ChevronRight className="h-4 w-4 text-amber-600" />
              ))}
          </div>
          <div
            className={`mt-2 text-3xl font-semibold ${
              dueSoon === 0 ? 'text-slate-400' : 'text-amber-700'
            }`}
          >
            {dueSoon}
          </div>
          <div
            className={`mt-1 text-xs ${
              dueSoon === 0 ? 'text-slate-400' : 'text-amber-600'
            }`}
          >
            {dueSoon === 0 ? '近期沒有即將到期項目' : '個 Action Items'}
          </div>
        </button>
      </div>

      {openCard === 'overdue' && overdueItems.length > 0 && (
        <ReminderItemList
          accent="red"
          items={overdueItems}
          onEdit={onEdit}
          emptyText="目前沒有逾期項目"
        />
      )}
      {openCard === 'dueSoon' && dueSoonItems.length > 0 && (
        <ReminderItemList
          accent="amber"
          items={dueSoonItems}
          onEdit={onEdit}
          emptyText="近期沒有即將到期項目"
        />
      )}
    </section>
  );
}

function ReminderItemList({
  accent,
  items,
  onEdit,
}: {
  accent: 'red' | 'amber';
  items: ActionItem[];
  onEdit: (it: ActionItem) => void;
  emptyText: string;
}) {
  const ring = accent === 'red' ? 'border-red-200' : 'border-amber-200';
  const dueColor =
    accent === 'red' ? 'text-red-700' : 'text-amber-700';
  return (
    <div className={`rounded-lg border ${ring} bg-white shadow-sm`}>
      <ul className="divide-y divide-slate-100">
        {items.map((it) => (
          <li key={it.id}>
            <button
              type="button"
              onClick={() => onEdit(it)}
              className="flex w-full items-start gap-3 p-3 text-left transition hover:bg-slate-50"
            >
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-mono text-slate-500">
                    {it.code}
                  </span>
                  {it.assignee && (
                    <span
                      className={`rounded px-1.5 py-0.5 text-[11px] ${ownerChipColor(
                        it.assignee,
                      )}`}
                    >
                      {it.assignee}
                    </span>
                  )}
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                    {it.status}
                  </span>
                </div>
                <div className="mt-1 text-sm text-slate-800 line-clamp-2">
                  {it.description}
                </div>
              </div>
              <div className={`whitespace-nowrap text-xs ${dueColor}`}>
                {it.due_date ? `截止 ${it.due_date.slice(5)}` : '—'}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RecentMeetingsRow({
  meetings,
}: {
  meetings: MeetingListItem[] | undefined;
}) {
  const navigate = useNavigate();

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-slate-800">最近 3 場會議</h2>
      {meetings && meetings.length === 0 && (
        <div className="rounded-md border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
          目前沒有會議記錄
        </div>
      )}
      {meetings && meetings.length > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {meetings.map((m) => (
            <button
              key={m.id}
              onClick={() => navigate(`/meetings/${m.id}`)}
              className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-blue-300 hover:shadow-md"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-slate-500">
                  {formatTime(m.start_time)}
                </span>
                {statusBadge(m.status)}
              </div>
              <div className="font-medium text-slate-800 line-clamp-2">
                {m.title}
              </div>
              <p className="text-xs leading-relaxed text-slate-600 line-clamp-3">
                {makePreview(m.summary)}
              </p>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function ActionItemsBlock({
  items,
  onEdit,
  onStatusChange,
  pendingId,
}: {
  items: ActionItem[] | undefined;
  onEdit: (it: ActionItem) => void;
  onStatusChange: (it: ActionItem, s: Status) => void;
  pendingId: number | null;
}) {
  const [showAllCompleted, setShowAllCompleted] = useState(false);

  // 完整分組（未經 7 天 filter）
  const byStatusAll = useMemo(() => {
    const m: Record<Status, ActionItem[]> = {
      未開始: [],
      進行中: [],
      已完成: [],
    };
    if (items) {
      for (const it of items) {
        if (m[it.status as Status]) m[it.status as Status].push(it);
      }
    }
    return m;
  }, [items]);

  const byStatus = useMemo(() => {
    const completedSorted = [...byStatusAll.已完成].sort(
      (a, b) => completedSortKey(b) - completedSortKey(a),
    );
    return {
      未開始: byStatusAll.未開始,
      進行中: byStatusAll.進行中,
      已完成: showAllCompleted
        ? completedSorted
        : completedSorted.slice(0, MAX_COMPLETED_DEFAULT),
    } satisfies Record<Status, ActionItem[]>;
  }, [byStatusAll, showAllCompleted]);

  const hiddenCompletedCount =
    byStatusAll.已完成.length - byStatus.已完成.length;

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-slate-800">Action Items</h2>
      {!items && <LoadingSpinner />}
      {items && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {STATUSES.map((s) => (
            <StatusColumn
              key={s}
              status={s}
              items={byStatus[s]}
              totalCount={byStatusAll[s].length}
              onEdit={onEdit}
              onStatusChange={onStatusChange}
              pendingId={pendingId}
              showAllCompleted={s === '已完成' ? showAllCompleted : undefined}
              onToggleShowAll={
                s === '已完成'
                  ? () => setShowAllCompleted((v) => !v)
                  : undefined
              }
              hiddenCompletedCount={
                s === '已完成' ? hiddenCompletedCount : undefined
              }
            />
          ))}
        </div>
      )}
    </section>
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
            {showAllCompleted ? (
              <EyeOff className="h-3 w-3" />
            ) : (
              <Eye className="h-3 w-3" />
            )}
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
                onClick={() => onEdit(it)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onEdit(it);
                  }
                }}
                className="cursor-pointer space-y-1.5 rounded-md border border-slate-200 bg-white p-2 shadow-sm transition hover:border-blue-300 hover:shadow-md"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="font-mono text-[10px] text-slate-400">
                    {it.code ?? '—'}
                  </span>
                  <Pencil className="h-3 w-3 text-slate-400" />
                </div>
                <div
                  className={`text-xs ${
                    it.status === '已完成'
                      ? 'text-slate-400 line-through'
                      : 'text-slate-700'
                  }`}
                >
                  {it.description}
                </div>
                <div className="flex justify-between text-[11px] text-slate-400">
                  <span>優先：{it.priority ?? '—'}</span>
                  <span>截止：{it.due_date ?? '—'}</span>
                </div>
                <div
                  className="flex justify-end pt-0.5"
                  onClick={(e) => e.stopPropagation()}
                >
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

// ---------- Page ------------------------------------------------------------

export default function OverviewPage() {
  const dept = getStoredDept();
  const queryClient = useQueryClient();
  const {
    data: recentMeetings,
    isLoading: meetingsLoading,
    error: meetingsError,
  } = useRecentMeetings();
  const {
    data: actionItems,
    isLoading: itemsLoading,
    error: itemsError,
  } = useOverviewActionItems();

  const [modal, setModal] = useState<ActionItemModalMode | null>(null);

  // 跟催警示計算 + 展開的卡片內容都封裝在 ReminderCards 內部

  // 最近 3 場會議（後端已 ORDER BY start_time DESC）
  const top3Meetings = useMemo<MeetingListItem[] | undefined>(() => {
    if (!recentMeetings) return undefined;
    return recentMeetings.slice(0, 3);
  }, [recentMeetings]);

  // 狀態切換 mutation — 兩個 query key 都 invalidate，跟 ActionItemsPage 保持同步
  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: Status }) =>
      api.patch<ActionItem>(`/api/action-items/${id}`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['overview', 'action-items'] });
      queryClient.invalidateQueries({ queryKey: ['action-items'] });
    },
  });

  function handleEdit(it: ActionItem) {
    setModal({ kind: 'edit', item: it });
  }

  function handleStatusChange(it: ActionItem, status: Status) {
    if (it.status === status) return;
    statusMutation.mutate({ id: it.id, status });
  }

  function handleCloseModal() {
    setModal(null);
    // ActionItemModal 內部會 invalidate ['action-items']，但 Overview 的 key 是
    // ['overview', 'action-items']，所以這裡額外 invalidate 一次。
    queryClient.invalidateQueries({ queryKey: ['overview', 'action-items'] });
  }

  const anyLoading = meetingsLoading || itemsLoading;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-800">總覽</h1>
        <p className="text-sm text-slate-500">
          {dept?.name ?? '—'} · 跟催警示、最近會議與 Action Items 一覽
        </p>
      </div>

      {anyLoading && <LoadingSpinner />}
      {meetingsError && <ErrorBanner error={meetingsError as Error} />}
      {itemsError && <ErrorBanner error={itemsError as Error} />}
      {statusMutation.isError && (
        <ErrorBanner error={statusMutation.error as Error} />
      )}

      <ReminderCards items={actionItems} onEdit={handleEdit} />

      <RecentMeetingsRow meetings={top3Meetings} />

      <ActionItemsBlock
        items={actionItems}
        onEdit={handleEdit}
        onStatusChange={handleStatusChange}
        pendingId={
          statusMutation.isPending
            ? (statusMutation.variables?.id ?? null)
            : null
        }
      />

      {modal && <ActionItemModal mode={modal} onClose={handleCloseModal} />}
    </div>
  );
}
